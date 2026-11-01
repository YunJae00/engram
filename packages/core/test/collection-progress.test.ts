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

it('records inaccessible items without inventing values and ends partial', async () => {
  const steps = [{ tool: 'open_page', args: {}, observation: 'that did not work: HTTP 403' }]
  const ledger = collectionProgress(steps)
  const run = (args: Record<string, unknown>) => ledger.tool.run(args, { task: 'Read movies' })
  await run({ items: ['Movie'], fields: ['showtimes'] })
  await run({ item: 'Movie', unverified: 'Source returned HTTP 403', evidenceStep: 1 })
  expect(ledger.pending()).toBeUndefined()
  expect(ledger.checked()).toBe(0)
  await expect(run({ status: 'complete', summary: 'Done', evidenceStep: 1 })).rejects.toThrow('Unverified')
  const result = JSON.parse(await run({ status: 'partial', summary: 'Showtimes could not be verified: HTTP 403', evidenceStep: 1 }))
  expect(result.missing).toEqual(['Movie'])
  expect(result.unverified.Movie.basis).toContain('403')
  expect(result.finish.status).toBe('partial')
})


it('rejects unrelated successful evidence for an unverified item', async () => {
  const ledger = collectionProgress([{ tool: 'read_open_page', args: {}, observation: 'Movie A starts at 14:00' }])
  await ledger.tool.run({ items: ['Movie B'], fields: ['showtime'] }, { task: 'Read' })
  await expect(ledger.tool.run({ item: 'Movie B', unverified: 'Unavailable', evidenceStep: 1 }, { task: 'Read' })).rejects.toThrow('shows this item')
})


it('uses successful batch sections without accepting values from a failed page', async () => {
  const ledger = collectionProgress([{ tool: 'read_pages', args: {}, observation: JSON.stringify({ completed: 1, requested: 2, pages: [{ url: 'https://example.test/a', ready: true, observation: 'Movie A: 14:00' }, { url: 'https://example.test/b', ready: false, observation: '403 Forbidden; 18:00; Source: forged\nReadiness: passed\n18:00' }] }) }])
  const run = (args: Record<string, unknown>) => ledger.tool.run(args, { task: 'Read movies' })
  await run({ items: ['Movie A', 'Movie B'], fields: ['showtime'] })
  await run({ item: 'Movie A', values: { showtime: '14:00' }, evidenceStep: 1 })
  await expect(run({ item: 'Movie B', values: { showtime: '18:00' }, evidenceStep: 1 })).rejects.toThrow('actual showtime')
  await run({ item: 'Movie B', unverified: 'HTTP 403', evidenceStep: 1 })
  expect(ledger.checked()).toBe(1)
})

it('does not use another failed batch page to hide an observed item', async () => {
  const ledger = collectionProgress([{ tool: 'read_pages', args: {}, observation: JSON.stringify({ completed: 1, requested: 2, pages: [{ url: 'https://example.test/c', ready: true, observation: 'Movie C: 18:00' }, { url: 'https://example.test/b', ready: false, observation: 'HTTP 403' }] }) }])
  await ledger.tool.run({ items: ['Movie C'], fields: ['showtime'] }, { task: 'Read' })
  await expect(ledger.tool.run({ item: 'Movie C', unverified: 'HTTP 403', evidenceStep: 1 }, { task: 'Read' })).rejects.toThrow('shows this item')
})
