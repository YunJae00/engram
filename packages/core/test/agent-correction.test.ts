import { expect, it, vi } from 'vitest'
import { runComet, correctableFault } from '../src/agent-session.js'
import type { AgentTool } from '../src/agent-loop.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'
import { formatAsk } from '../src/ask.js'

const workdir = 'C:/tmp' as EngineCwd
const write: AgentTool = { name: 'excel_write', description: 'write', argsSchema: {}, run: async () => JSON.stringify({ workbook: 'B.xlsx', sheet: 'S' }) }
const read: AgentTool = { name: 'excel_read', description: 'read', argsSchema: {}, run: async () => JSON.stringify({ workbook: 'B.xlsx', sheet: 'S', range: 'A1', rows: [[1]] }) }
const brain = (runTools: (job: ToolSessionJob) => Promise<{ answer: string }>) => ({ id: 'mock', runTools }) as unknown as Engine
const writeCell = (job: ToolSessionJob) => job.tools.find(t => t.name === 'excel_write')!.run({ cells: [{ cell: 'A1', value: 1 }] })

it.each(['no read', 'wrong workbook', 'failed read'])('keeps the original write unverified after correction: %s', async mode => {
  let pass = 0
  const engine = brain(async job => {
    if (++pass === 1) await writeCell(job)
    else if (mode !== 'no read') await job.tools.find(t => t.name === 'excel_read')!.run({})
    return { answer: 'Done' }
  })
  const badRead = { ...read, run: async () => mode === 'failed read' ? 'that did not work: unavailable' : JSON.stringify({ workbook: 'Other.xlsx', sheet: 'S', range: 'A1', rows: [[1]] }) }
  const result = await runComet({ engine, workdir, tools: [write, badRead] }, 'Update A1', { guided: false })
  expect(pass).toBe(2)
  expect(result.steps[0]!.tool).toBe('excel_write')
  expect(result.incomplete).toContain('read back')
  expect(result.answer).toContain('Not verified as complete')
})

it('retains both passes, uses remaining budget and resets the streamed answer', async () => {
  let pass = 0
  const reset = vi.fn()
  const engine = brain(async job => {
    if (++pass === 1) { await writeCell(job); job.onToken?.('Unverified draft') }
    else {
      expect(reset).toHaveBeenCalledOnce()
      expect(job.maxCalls).toBe(3)
      expect(job.prompt).toContain('B.xlsx')
      expect(job.prompt).toContain('Do not recreate outputs')
      await job.tools.find(t => t.name === 'excel_read')!.run({})
    }
    return { answer: 'Read back A1' }
  })
  const result = await runComet({ engine, workdir, tools: [write, read] }, 'Update A1', { guided: false, maxCalls: 4, onReset: reset })
  expect(result.incomplete).toBeUndefined()
  expect(result.steps.map(s => s.tool)).toEqual(['excel_write', 'excel_read'])
})

it.each(['Do not retry', '실패하면 재시도하지 마'])('honors the user restriction: %s', async task => {
  const run = vi.fn(async (job: ToolSessionJob) => { await writeCell(job); return { answer: 'Unverified' } })
  const result = await runComet({ engine: brain(run), workdir, tools: [write] }, task, { guided: false })
  expect(run).toHaveBeenCalledOnce()
  expect(result.incomplete).toBeTruthy()
})

it('does not retry exhausted calls or stopped desktop control', async () => {
  const run = vi.fn(async (job: ToolSessionJob) => { await writeCell(job); return { answer: 'Unverified' } })
  const result = await runComet({ engine: brain(run), workdir, tools: [write] }, 'Update A1', { guided: false, maxCalls: 1 })
  expect(run).toHaveBeenCalledOnce()
  expect(result.stopped).toBe('calls')
  expect(correctableFault({ answer: 'Stopped', steps: [{ tool: 'desktop_action', args: {}, observation: 'that did not work: Computer control was cancelled for this turn.' }], fellBack: false, incomplete: 'The last computer or file result failed or may be stale and has not been verified.' })).toBeUndefined()
})

it('preserves the unfinished result when the correction engine fails', async () => {
  let pass = 0
  const engine = brain(async job => {
    if (++pass === 2) throw new Error('usage limit')
    await writeCell(job)
    return { answer: 'Unverified' }
  })
  const result = await runComet({ engine, workdir, tools: [write] }, 'Update A1', { guided: false })
  expect(result.incomplete).toBeTruthy()
  expect(result.steps).toHaveLength(1)
})

it('does not start correction after cancellation', async () => {
  const controller = new AbortController()
  const engine = brain(async job => { await writeCell(job); controller.abort(); return { answer: 'Stopped' } })
  await expect(runComet({ engine, workdir, tools: [write] }, 'Update A1', { guided: false, signal: controller.signal })).rejects.toThrow()
})

it('preserves a request for approval during correction instead of claiming success', async () => {
  let pass = 0
  const ask = { name: 'ask_person', description: 'ask', argsSchema: {}, run: async () => formatAsk('Which workbook?', ['A', 'B']) }
  const engine = brain(async job => {
    if (++pass === 1) await writeCell(job)
    else await job.tools.find(t => t.name === 'ask_person')!.run({})
    return { answer: 'Done' }
  })
  const result = await runComet({ engine, workdir, tools: [write, ask] }, 'Update A1', { guided: false })
  expect(result.asked).toBe(true)
  expect(result.answer).toBe('Which workbook?')
  expect(result.steps).toHaveLength(2)
  expect(result.incomplete).toBeTruthy()
})

it('retains a SUM discrepancy when the second pass reads only values', async () => {
  let pass = 0
  const totals = { ...read, run: async () => JSON.stringify({ workbook: 'B.xlsx', sheet: 'S', range: 'A1:C1', rows: [[1, 2, 99]], ...(pass === 1 ? { formulas: [[1, 2, '=SUM(A1:B1)']] } : {}) }) }
  const engine = brain(async job => { pass++; await job.tools.find(t => t.name === 'excel_read')!.run({}); return { answer: 'Corrected' } })
  const result = await runComet({ engine, workdir, tools: [totals] }, 'Verify totals', { guided: false })
  expect(pass).toBe(2)
  expect(result.incomplete).toContain('does not add up')
})

it('corrects through the step engine without resetting its model-call budget', async () => {
  let calls = 0
  const outputs = [
    { tool: 'excel_write', args: { cells: [{ cell: 'A1', value: 1 }] } },
    { tool: 'answer', args: { text: 'Written' } },
    { tool: 'excel_read', args: {} },
    { tool: 'answer', args: { text: 'Read back' } },
  ]
  const engine = { id: 'mock', run: async function* () { yield { type: 'result', text: JSON.stringify(outputs[calls++]) } } } as unknown as Engine
  const result = await runComet({ engine, workdir, tools: [write, read] }, 'Update A1', { guided: false, maxCalls: 4 })
  expect(calls).toBe(4)
  expect(result.incomplete).toBeUndefined()
  expect(result.steps.map(s => s.tool)).toEqual(['excel_write', 'excel_read'])
})
