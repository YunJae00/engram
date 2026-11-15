import { expect, it } from 'vitest'
import { listTasks } from 'core'
import { done, setup } from './task-runner-fixture.js'
import { recheckAddsNothing } from '../src/main/task-runner.js'

it('preserves the engine answer and reported limitations through one verification retry', async () => {
  const answer = 'Updated the report. The external source is unavailable.'
  const t = await setup(async () => ({ ...done(answer, 1), check: { accepted: false, issues: ['Source unavailable'] } }))
  await t.chat('Update the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]?.result).toBe(answer)
})

// qa142: every finished task was reported twice (the answer, then the re-check repeating it).
it('reports once when the re-check passes without changing anything', async () => {
  const report = 'Saved. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } }
    : { ...done(`Checked again; all rows match. [Report](engram-artifact:report.md)`, 1), check: { accepted: true, issues: [], reportUnchanged: true }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([])
})
it('still reports what a re-check changed', async () => {
  const fixed = 'Fixed one row. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Saved. [Report](engram-artifact:report.md)', 1), check: { accepted: false, issues: ['Row 3 differs'] } }
    : { ...done(fixed, 2), check: { accepted: true, issues: [] }, trail: [{ tool: 'file_create_copy', args: {}, observation: '{}' }, { tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done' })
  expect(t.delivered).toEqual([fixed])
})

// qa142 p2b-r1 #2: silence is only for a re-check that confirms the report; a correction is posted, once.
it('posts a re-check that passes a requirement the delivered report had left failed, though it changed no file', async () => {
  const corrected = 'The total is 14, not 12 as I said. [Report](engram-artifact:report.md)'
  const verdict = (status: 'pass' | 'fail') => ({ checks: [{ requirement: 'Total matches the source', status, basis: 'Compared with the source' }], grounding: { status: 'pass' as const, basis: 'Read the source' }, sources: [] })
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Saved; the total is 12. [Report](engram-artifact:report.md)', 1), check: { accepted: true, verified: false, issues: ['Total matches the source: fail'], report: verdict('fail') } }
    : { ...done(corrected, 1), check: { accepted: true, issues: [], report: verdict('pass') }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([corrected])
})
it('posts a re-check that hands over a different file than the report did', async () => {
  const other = 'The checked file is this one. [Final](engram-artifact:final.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Saved. [Report](engram-artifact:report.md)', 1), check: { accepted: false, issues: ['Row count not read back'] } }
    : { ...done(other, 1), check: { accepted: true, issues: [] }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect(t.delivered).toEqual([other])
})
it('stays silent when the confirming re-check links the same file under its saved-copy id', async () => {
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Saved. [Report](engram-artifact:report.md)', 1), check: { accepted: false, issues: ['Row count not read back'] } }
    : { ...done('All rows match. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)', 1), check: { accepted: true, issues: [], reportUnchanged: true }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect(t.delivered).toEqual([])
})

// qa142 p2b-r2 #1: a readback can correct a statement of a report whose own check passed, without touching a file;
// only the re-check's own word that the report stands keeps it out of the thread.
const passed = { checks: [{ requirement: 'Total matches the source', status: 'pass' as const, basis: 'Compared with the source' }], grounding: { status: 'pass' as const, basis: 'Read the source' }, sources: [] }
const readback = [{ tool: 'read_open_page', args: {}, observation: 'Read back' }]
const recheck = (answer: string, reportUnchanged?: boolean) => setup(async (_request, turn) => turn === 1
  ? { ...done('Saved; the total is 12. [Report](engram-artifact:report.md)', 1), check: { accepted: true, issues: ['Row count not read back'], report: passed } }
  : { ...done(answer, 1), check: { accepted: true, issues: [], report: passed, ...(reportUnchanged === undefined ? {} : { reportUnchanged }) }, trail: readback })
it('posts a re-check that corrects a statement of a passing report without changing a file', async () => {
  const corrected = 'The total is 14, not 12 as I said. [Report](engram-artifact:report.md)'
  const t = await recheck(corrected, false)
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([corrected])
})
it('posts a passing re-check that does not say the report is unchanged', async () => {
  const again = 'Checked again. [Report](engram-artifact:report.md)'
  const t = await recheck(again)
  await t.chat('Save the report')
  expect(t.delivered).toEqual([again])
})
it('stays silent when a confirm-only re-check affirms the report is unchanged', async () => {
  const t = await recheck('Checked again; the total is 12. [Report](engram-artifact:report.md)', true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([])
})

// qa142 p2b-r3: reportUnchanged is necessary, not sufficient; the host reads the re-check answer itself and posts what corrects or adds.
it.each([
  ['an English correction', 'The total is 14, not 12 as I said. [Report](engram-artifact:report.md)'],
  ['a Korean correction', '합계는 12가 아니라 14야. [Report](engram-artifact:report.md)'],
  ['a number the report lacks', 'Checked again; the total is 12 across 37 rows. [Report](engram-artifact:report.md)'],
])('posts a re-check with %s though it says the report is unchanged', async (_name, answer) => {
  const t = await recheck(answer, true)
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([answer])
})
it('reads whether a re-check answer adds anything to the delivered report', () => {
  const report = 'Saved; the total is 12 for `sales.csv`. [Report](engram-artifact:report.md)'
  expect(recheckAddsNothing('Checked again; the total is 12 for `sales.csv`. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)', report)).toBe(true)
  expect(recheckAddsNothing('Checked again; all rows match.', report)).toBe(true)
  expect(recheckAddsNothing('The total is 14, not 12.', report)).toBe(false)
  expect(recheckAddsNothing('합계는 12가 아니라 14야', report)).toBe(false)
  expect(recheckAddsNothing('The total is 120.', report)).toBe(false)
  expect(recheckAddsNothing('The total is 12%.', report)).toBe(false)
  expect(recheckAddsNothing('The total is 12 for `orders.csv`.', report)).toBe(false)
  expect(recheckAddsNothing('The total is 12 under "Q3".', report)).toBe(false)
  expect(recheckAddsNothing('The total is 12. See https://example.com/a', report)).toBe(false)
  expect(recheckAddsNothing('I corrected the wording; the total is 12.', report)).toBe(false)
})
// qa142 p2b-r4: values are compared where they stand, not as a bag; a swap or a unit change of values the report already has is posted.
it('posts a re-check that swaps values or changes a unit the delivered report already has', () => {
  expect(recheckAddsNothing('A: 14; B: 12.', 'A: 12; B: 14.')).toBe(false)
  expect(recheckAddsNothing('Total: 12 kg.', 'Total: 12 lb.')).toBe(false)
  expect(recheckAddsNothing('Total: $12.', 'Total: €12.')).toBe(false)
  expect(recheckAddsNothing('Total: -12.', 'Total: 12.')).toBe(false)
  expect(recheckAddsNothing('`a.csv` has 14 rows, `b.csv` has 12.', '`a.csv` has 12 rows, `b.csv` has 14.')).toBe(false)
  expect(recheckAddsNothing('합계 14건, 오류 12건', '합계 12건, 오류 14건')).toBe(false)
})
it('stays silent when a re-check restates the values in the same context', () => {
  expect(recheckAddsNothing('A: 12; B: 14.', 'A: 12; B: 14.')).toBe(true)
  expect(recheckAddsNothing('Checked again. A: 12; B: 14.', 'Saved. A: 12; B: 14.')).toBe(true)
  expect(recheckAddsNothing('checked again — **a**: １２; b: *14*.', 'Saved. A: 12; B: 14.')).toBe(true)
  expect(recheckAddsNothing('다시 확인함. 합계 12건, 오류 14건', '저장함. 합계 12건, 오류 14건')).toBe(true)
})
it('posts through the runner a swap the re-check calls unchanged', async () => {
  const swapped = 'A: 14; B: 12. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('A: 12; B: 14. [Report](engram-artifact:report.md)', 1), check: { accepted: true, issues: ['Row count not read back'], report: passed } }
    : { ...done(swapped, 1), check: { accepted: true, issues: [], report: passed, reportUnchanged: true }, trail: readback })
  await t.chat('Save the report')
  expect(t.delivered).toEqual([swapped])
})
