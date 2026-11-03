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
  const steps = [{ tool: 'open_page', args: {}, observation: 'HTTP 401: Sign in to read entries' }]
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
  expect(result.unverified.Movie.basis).not.toContain('does not establish')
  expect(result.finish.status).toBe('partial')
})


it('accepts an unverified report without treating another item as proof', async () => {
  const ledger = collectionProgress([{ tool: 'read_open_page', args: {}, observation: 'Movie A starts at 14:00' }])
  await ledger.tool.run({ items: ['Movie A', 'Movie B'], fields: ['showtime'] }, { task: 'Read' })
  await ledger.tool.run({ item: 'Movie B', unverified: 'Unavailable', evidenceStep: 1 }, { task: 'Read' })
  expect(ledger.checked()).toBe(0)
  expect(ledger.summary()).toContain('Not verified')
  expect(ledger.summary()).toContain('does not establish')
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

it('an unverified batch report never becomes checked', async () => {
  const ledger = collectionProgress([{ tool: 'read_pages', args: {}, observation: JSON.stringify({ completed: 1, requested: 2, pages: [{ url: 'https://example.test/c', ready: true, observation: 'Movie C: 18:00' }, { url: 'https://example.test/b', ready: false, observation: 'HTTP 403' }] }) }])
  await ledger.tool.run({ items: ['Movie C'], fields: ['showtime'] }, { task: 'Read' })
  await ledger.tool.run({ item: 'Movie C', unverified: 'HTTP 403', evidenceStep: 1 }, { task: 'Read' })
  expect(ledger.checked()).toBe(0)
  expect(ledger.open()).toBe(true)
  expect(ledger.summary()).toContain('does not establish')
})

it('accepts partial completion with unresolved items and preserves their visible uncertainty', async () => {
  const ledger = collectionProgress([])
  await ledger.tool.run({ items: ['A', 'B'], fields: ['availability'] }, { task: 'Read' })
  const result = JSON.parse(await ledger.tool.run({ status: 'partial', summary: 'Availability cannot be checked', evidenceStep: 99 }, { task: 'Read' }))
  expect(result.finish.status).toBe('partial')
  expect(result.checked).toBe(0)
  expect(result.unverified.A.basis).toContain('No verified result')
  expect(ledger.summary()).toContain('B: Not verified')
  expect(ledger.pending()).toBeUndefined()
  expect(result.next).toContain('do not resubmit')
})
it('accepts a mixed limitation report without validating its supplied values', async () => {
  const ledger = collectionProgress([])
  await ledger.tool.run({ items: ['A'], fields: ['availability'] }, { task: 'Read' })
  await ledger.tool.run({ item: 'A', values: { availability: 'yes' }, unverified: 'Cannot confirm', evidenceStep: 99 }, { task: 'Read' })
  expect(ledger.checked()).toBe(0)
  expect(ledger.summary()).toContain('Unverified supplied fields: availability')
  expect(ledger.summary()).toContain('No supporting observation was linked')
})

it('retains an evidenced field without promoting missing fields to success', async () => {
  const ledger = collectionProgress([{ tool: 'read_open_page', args: {}, observation: 'Movie A at 14:00. Availability not published.' }])
  const run = (args: Record<string, unknown>) => ledger.tool.run(args, { task: 'Read' })
  await run({ items: ['A'], fields: ['time', 'availability'] })
  const result = JSON.parse(await run({ item: 'A', values: { time: '14:00', availability: 'available' }, unverified: 'Availability not published', evidenceStep: 1 }))
  expect(result.verifiedFields.A).toEqual({ time: '14:00' })
  expect(result.checked).toBe(0)
  expect(ledger.summary()).toContain('Confirmed fields: time: 14:00')
  await expect(run({ status: 'complete', summary: 'Done', evidenceStep: 1 })).rejects.toThrow('Unverified')
})

it('does not present an invented access barrier as observed', async () => {
  const ledger = collectionProgress([{ tool: 'read_open_page', args: {}, observation: 'Accessible content, room 1403. Log in for preferences.' }])
  await ledger.tool.run({ status: 'blocked', summary: 'Cannot continue', evidenceStep: 1 }, { task: 'Read' })
  expect(ledger.finish()).toMatchObject({ status: 'partial', summary: expect.stringContaining('No access barrier was observed') })
})

it('retains evidenced fields when another submitted field is rejected', async () => {
  const ledger = collectionProgress([{ tool: 'read_open_page', args: {}, observation: 'Record 1. Title: Amber. Date: 2026-10-21.' }])
  const run = (args: Record<string, unknown>) => ledger.tool.run(args, { task: 'Summarize the records' })
  await run({ items: ['Record 1'], fields: ['title', 'summary'] })
  await expect(run({ item: 'Record 1', values: { title: 'Amber', summary: 'A detailed invented summary' }, evidenceStep: 1 })).rejects.toThrow('actual summary')
  await run({ item: 'Record 1', unverified: 'No summary field was shown.', evidenceStep: 1 })
  await run({ status: 'partial', summary: 'Only the title was confirmed.' })
  const report = JSON.parse(await run({}))
  expect(report.verifiedFields['Record 1']).toEqual({ title: 'Amber' })
  expect(report.checked).toBe(0)
  expect(ledger.summary()).toContain('Confirmed fields: title: Amber')
  await expect(run({ status: 'complete', summary: 'Everything checked', evidenceStep: 1 })).rejects.toThrow()
})

it.each(['{"error":"accessibility_denied"}', '{"error":"screen_recording_denied"}', '{"error":"input_monitoring_denied"}', '{"error":"policy_denied"}', 'requires manual control (window: 로그인)', 'complete sign-in or security steps'])('reports an observed access barrier honestly: %s', async observation => {
  const ledger = collectionProgress([{ tool: 'app_read', args: {}, observation }])
  await ledger.tool.run({ status: 'blocked', summary: 'Cannot continue', evidenceStep: 1 }, { task: 'Read the app' })
  expect(ledger.finish()).toMatchObject({ status: 'blocked', summary: expect.stringContaining('Blocked by a permission or security screen') })
  expect(ledger.finish()?.summary).not.toContain('No access barrier')
})
it('localizes the access barrier for a Korean task', async () => {
  const ledger = collectionProgress([{ tool: 'app_read', args: {}, observation: '{"error":"screen_recording_denied"}' }])
  await ledger.tool.run({ status: 'partial', summary: '확인하지 못했어요', evidenceStep: 1 }, { task: '앱을 읽어 주세요' })
  expect(ledger.finish()?.summary).toContain('권한 또는 보안 화면에 막혔어요')
})

it.each(['Sign in', '로그인', 'Log in', 'security screen', '보안 화면', 'accessibility_denied'])('does not infer an access barrier from screen text: %s', async observation => {
  const ledger = collectionProgress([{ tool: 'app_read', args: {}, observation }])
  await ledger.tool.run({ status: 'blocked', summary: 'Cannot continue', evidenceStep: 1 }, { task: 'Read the app' })
  expect(ledger.finish()).toMatchObject({ status: 'partial', summary: expect.stringContaining('No access barrier was observed') })
  expect(ledger.finish()?.summary).not.toContain('Blocked by a permission or security screen')
})
