import { expect, it } from 'vitest'
import { collectionProgress } from '../src/collection-progress.js'
import type { AgentLoopStep } from '../src/agent-loop.js'

it('keeps all eleven discovered items pending until their actual fields are read', async () => {
  const steps: AgentLoopStep[] = []
  const ledger = collectionProgress(steps)
  const run = (args: Record<string, unknown>) => ledger.tool.run(args, { task: 'Read every entry' })
  await run({ items: Array.from({ length: 11 }, (_, i) => `Entry ${i}`), fields: ['remark'] })
  for (let i = 0; i < 2; i++) {
    steps.push({ tool: 'read_open_page', args: {}, observation: `Entry ${i}: Detail ${i}` })
    await run({ item: `Entry ${i}`, values: { remark: `Detail ${i}` }, evidenceStep: steps.length })
  }
  expect(ledger.pending()).toContain('2/11')
  await run({ items: ['Entry 0', 'Entry 1'] })
  expect(ledger.pending()).toContain('2/11')
  await expect(run({ item: 'Entry 2', values: { remark: 'Not shown' }, evidenceStep: 1 })).rejects.toThrow('actual remark')
  await expect(run({ item: 'Entry 2', values: { remark: 'Detail 0' }, evidenceStep: 99 })).rejects.toThrow('observation')
  for (let i = 2; i < 11; i++) {
    steps.push({ tool: 'read_open_page', args: {}, observation: `Entry ${i}: Detail ${i}` })
    await run({ item: `Entry ${i}`, values: { remark: `Detail ${i}` }, evidenceStep: steps.length })
  }
  expect(ledger.pending()).toBeUndefined()
  expect(JSON.parse(await run({})).checked).toBe(11)
})

it('does not accept a failed read or a fabricated observation from the ledger', async () => {
  const steps = [{ tool: 'collect_results', args: {}, observation: 'Detail 1' }, { tool: 'read_open_page', args: {}, observation: 'that did not work: Detail 1' }]
  const ledger = collectionProgress(steps)
  await ledger.tool.run({ items: ['Entry 1'], fields: ['remark'] }, { task: 'Read' })
  for (const evidenceStep of [1, 2]) await expect(ledger.tool.run({ item: 'Entry 1', values: { remark: 'Detail 1' }, evidenceStep }, { task: 'Read' })).rejects.toThrow('observation')
})

it('rejects completion with missing items or missing evidence, and allows an observed barrier', async () => {
  const steps = [{ tool: 'open_page', args: {}, observation: 'Sign in to read entries' }]
  const ledger = collectionProgress(steps)
  const run = (args: Record<string, unknown>) => ledger.tool.run(args, { task: 'Read entries' })
  await expect(run({ status: 'complete', summary: 'Done', evidenceStep: 9 })).rejects.toThrow('observation')
  await run({ items: ['Entry'], fields: ['remark'] })
  await expect(run({ status: 'complete', summary: 'Done', evidenceStep: 1 })).rejects.toThrow('0/1')
  await run({ status: 'blocked', summary: 'Sign-in required', evidenceStep: 1 })
  expect(ledger.finish()?.status).toBe('blocked')
  ledger.invalidate()
  expect(ledger.finish()).toBeUndefined()
})
