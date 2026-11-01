import { expect, it } from 'vitest'
import { runToolSession } from '../src/agent-session.js'
import type { Engine, EngineCwd, ToolSessionJob } from '../src/engine/types.js'
import { TASK_TOKEN_BUDGET } from '../src/delegated-tasks.js'

it('uses the shared 300,000-token default and describes the exhausted allowance', async () => {
  expect(TASK_TOKEN_BUDGET).toBe(300_000)
  const engine = { runTools: (job: ToolSessionJob) => {
    job.onUsage?.(TASK_TOKEN_BUDGET - 1)
    expect(job.signal?.aborted).toBe(false)
    job.onUsage?.(1)
    return new Promise(() => {})
  } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: [] }, 'Work')
  expect(result.budgetExhausted).toBe(true)
  expect(result.tokensUsed).toBe(TASK_TOKEN_BUDGET)
  expect(result.answer).toContain('300,000 new tokens available for this turn')
})

it('stops at reported token usage even when the engine ignores cancellation', async () => {
  const engine = { runTools: (job: ToolSessionJob) => {
    job.onUsage?.(40)
    expect(job.signal?.aborted).toBe(false)
    job.onUsage?.(60)
    return new Promise(() => {})
  } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: [] }, 'Work', { tokenBudget: 100 })
  expect(result.budgetExhausted).toBe(true)
  expect(result.tokensUsed).toBe(100)
})

it('exposes engine input delivery without waiting for an Engram tool call', async () => {
  const delivered: string[][] = []
  let receive: ((messages: string[]) => Promise<boolean>) | null = null
  const engine = { runTools: async (job: ToolSessionJob) => {
    job.onSteerable?.(async messages => { delivered.push(messages); return true })
    expect(await receive?.(['Only read'])).toBe(true)
    return { answer: 'Read only' }
  } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: [] }, 'Inspect', { onSteerable: steer => { receive = steer } })
  expect(result.answer).toBe('Read only')
  expect(delivered).toEqual([['Only read']])
  expect(receive).toBeNull()
})

it('warns once through steering at 80 percent and keeps the hard stop', async () => {
  const warnings: string[][] = []
  const engine = { runTools: async (job: ToolSessionJob) => {
    job.onSteerable?.(async messages => { warnings.push(messages); return true })
    job.onUsage?.(79)
    expect(warnings).toHaveLength(0)
    job.onUsage?.(1)
    job.onUsage?.(10)
    await Promise.resolve()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]![0]).toContain('20 new tokens remaining')
    job.onUsage?.(10)
    return { answer: '' }
  } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: [] }, 'Work', { tokenBudget: 100 })
  expect(result.budgetExhausted).toBe(true)
})

it('delivers the warning in the next tool observation when live steering is unavailable', async () => {
  const engine = { runTools: async (job: ToolSessionJob) => {
    job.onUsage?.(80)
    expect(await job.tools[0]!.run({})).toContain('Token budget nearly exhausted')
    expect(await job.tools[0]!.run({})).not.toContain('Token budget nearly exhausted')
    return { answer: 'Partial result' }
  } } as unknown as Engine
  await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: [{ name: 'read_note', description: '', argsSchema: {}, run: async () => 'Read' }] }, 'Read', { tokenBudget: 100 })
})

it('keeps unavailable collection items visible even if the model omits them from its answer', async () => {
  const engine = { runTools: async (job: ToolSessionJob) => {
    const ledger = job.tools.find(tool => tool.name === 'collect_results')!
    await job.tools.find(tool => tool.name === 'open_page')!.run({})
    await ledger.run({ items: ['Movie A'], fields: ['showtimes'] })
    await ledger.run({ item: 'Movie A', unverified: 'HTTP 403', evidenceStep: 1 })
    return { answer: 'Here is what I found.' }
  } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'tmp' as EngineCwd,
    tools: [{ name: 'open_page', description: '', argsSchema: {}, run: async () => 'HTTP 403' }] }, 'Read movie showtimes')
  expect(result.incomplete).toContain('Movie A: HTTP 403')
  expect(result.answer).toContain('Unverified collection items (1/1)')
})


it('preserves collected values and unavailable items in a budget stop answer', async () => {
  const engine = { runTools: async (job: ToolSessionJob) => {
    await job.tools.find(tool => tool.name === 'open_page')!.run({})
    const ledger = job.tools.find(tool => tool.name === 'collect_results')!
    await ledger.run({ items: ['Movie A', 'Movie B'], fields: ['showtime'] })
    await ledger.run({ item: 'Movie A', values: { showtime: '14:00' }, evidenceStep: 1 })
    await ledger.run({ item: 'Movie B', unverified: 'HTTP 403', evidenceStep: 1 })
    job.onUsage?.(100)
    return { answer: '' }
  } } as unknown as Engine
  const result = await runToolSession({ engine, workdir: 'tmp' as EngineCwd,
    tools: [{ name: 'open_page', description: '', argsSchema: {}, run: async () => 'Movie A: 14:00; Movie B: HTTP 403' }] }, 'Read showtimes', { tokenBudget: 100 })
  expect(result.budgetExhausted).toBe(true)
  expect(result.answer).toContain('Movie A: showtime: 14:00')
  expect(result.answer).toContain('Movie B: Not verified — HTTP 403')
})
