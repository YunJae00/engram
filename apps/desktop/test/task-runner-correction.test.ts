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
// p2b-r7: only the report again is silent; any other answer is posted, once.
// p2b-r8: whitespace aside only. Emphasis markers and a saved copy's id are part of the text.
// p2b-r9: the same text only; line endings and whitespace around the whole text aside. Line wrapping is part of the text.
const unchanged = (report: string, answer: string) => setup(async (_request, turn) => turn === 1
  ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } }
  : { ...done(answer, 1), check: { accepted: true, issues: [], reportUnchanged: true }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
it('reports once when the re-check passes and repeats the report', async () => {
  const report = 'Saved. [Report](engram-artifact:report.md)'
  const t = await unchanged(report, report)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  // qa143 S19 d: the report waited for its re-check instead of being posted before it, so the runner posts it, once.
  expect(t.delivered).toEqual([report])
})
it('posts once a re-check that confirms in words the report lacks', async () => {
  const confirmed = 'Checked again; all rows match. [Report](engram-artifact:report.md)'
  const t = await unchanged('Saved. [Report](engram-artifact:report.md)', confirmed)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([confirmed])
})
it.each([
  ['Rows match.', 'Rows differ.'],
  ['No changes.', 'Changes were made.'],
])('posts through the runner "%s" after "%s" though the re-check calls the report unchanged', async (answer, report) => {
  const t = await unchanged(`${report} [Report](engram-artifact:report.md)`, `${answer} [Report](engram-artifact:report.md)`)
  await t.chat('Save the report')
  expect(t.delivered).toEqual([`${answer} [Report](engram-artifact:report.md)`])
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
it('posts a confirming re-check in its own words that links the same file under its saved-copy id', async () => {
  const confirmed = 'All rows match. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)'
  const t = await unchanged('Saved. [Report](engram-artifact:report.md)', confirmed)
  await t.chat('Save the report')
  expect(t.delivered).toEqual([confirmed])
})
it('posts a re-check that repeats the report with the file under its saved-copy id', async () => {
  const answer = 'Saved. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)'
  const t = await unchanged('Saved. [Report](engram-artifact:report.md)', answer)
  await t.chat('Save the report')
  expect(t.delivered).toEqual([answer])
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
it('posts once a confirm-only re-check that affirms the report is unchanged in words of its own', async () => {
  const confirmed = 'Checked again; the total is 12. [Report](engram-artifact:report.md)'
  const t = await recheck(confirmed, true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([confirmed])
})
it('posts once a re-check that restates only part of the report and affirms it is unchanged', async () => {
  const part = 'The total is 12. [Report](engram-artifact:report.md)'
  const t = await recheck(part, true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([part])
})
it('posts once a re-check that repeats the report, rewrapped, though it affirms it is unchanged', async () => {
  const rewrapped = 'Saved; the total\nis 12.\n\n[Report](engram-artifact:report.md)\n'
  const t = await recheck(rewrapped, true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([rewrapped])
})
it('posts once a re-check that repeats the report, rewrapped and emphasised, though it affirms it is unchanged', async () => {
  const emphasised = '**Saved;** the total\nis ~~12~~.\n\n[Report](engram-artifact:report.md)'
  const t = await recheck(emphasised, true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([emphasised])
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
  expect(recheckAddsNothing('Saved; the total is 12 for `sales.csv`. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)', report)).toBe(false)
  expect(recheckAddsNothing('The total is 12 for `sales.csv`. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)', report)).toBe(false)
  expect(recheckAddsNothing('Checked again; the total is 12 for `sales.csv`. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)', report)).toBe(false)
  expect(recheckAddsNothing('Checked again; all rows match.', report)).toBe(false)
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
it('stays silent on the same values repeated and posts a restatement of part of the report', () => {
  expect(recheckAddsNothing('A: 12; B: 14.', 'A: 12; B: 14.')).toBe(true)
  expect(recheckAddsNothing('A: 12; B: 14.', 'Saved. A: 12; B: 14.')).toBe(false)
  expect(recheckAddsNothing('합계 12건, 오류 14건', '저장함. 합계 12건, 오류 14건')).toBe(false)
})
// qa142 p2b-r7: the report again is silent whatever its line wrapping; case, punctuation and wording are kept.
// p2b-r8: so are emphasis markers and a saved copy's id.
// p2b-r9: line wrapping and full-width forms are kept too; only CRLF/CR and whitespace around the whole text are set aside.
it('stays silent only when a re-check repeats the report verbatim and posts one with other line wrapping, width or emphasis', () => {
  const report = 'Saved. A: 12; B: 14.\nStatus: passed. [Report](engram-artifact:report.md)'
  expect(recheckAddsNothing(report, report)).toBe(true)
  expect(recheckAddsNothing('  **Saved.**\n\n**A**:   １２;\nB: *14*.\n\n__Status__:   `passed`.   ~~[Report](engram-artifact:report.md)~~\n', report)).toBe(false)
  expect(recheckAddsNothing('  Saved.\n\nA:   １２;\nB: 14.\n\nStatus:\tpassed.\r\n[Report](engram-artifact:report.md)\n', report)).toBe(false)
  expect(recheckAddsNothing('Saved. A: １２; B: 14.\nStatus: passed. [Report](engram-artifact:report.md)', report)).toBe(false)
  expect(recheckAddsNothing('Saved. A: 12; B: 14. Status: passed. [Report](engram-artifact:report.md)', report)).toBe(false)
  expect(recheckAddsNothing('Saved. A: 12;  B: 14.\nStatus: passed. [Report](engram-artifact:report.md)', report)).toBe(false)
  expect(recheckAddsNothing(`\n  ${report.replace('\n', '\r\n')}\r\n`, report)).toBe(true)
  expect(recheckAddsNothing(report.replace('\n', '\r'), report)).toBe(true)
  expect(recheckAddsNothing(`${report}\n`, report)).toBe(true)
  expect(recheckAddsNothing('  **Saved.**\n\n- **a**:   １２;\n- b: *14*.\n\n__Status__:   passed.   [Report](engram-artifact:report.md)\n', report)).toBe(false)
  expect(recheckAddsNothing('saved. a: 12; b: 14. status: passed. [Report](engram-artifact:report.md)', report)).toBe(false)
  expect(recheckAddsNothing('Saved report_final.md and 2 * 3.', 'Saved reportfinal.md and 2 3.')).toBe(false)
  expect(recheckAddsNothing('[Report](engram-artifact:a_b.md)', '[Report](engram-artifact:ab.md)')).toBe(false)
})
it('posts a re-check that strikes through a claim of the report', () => {
  expect(recheckAddsNothing('Saved. ~~All tests passed.~~', 'Saved. All tests passed.')).toBe(false)
  expect(recheckAddsNothing('Saved. All tests passed.', 'Saved. ~~All tests passed.~~')).toBe(false)
  expect(recheckAddsNothing('Saved. **All** tests passed.', 'Saved. All tests passed.')).toBe(false)
})
it('posts a re-check that links another saved copy of the same file name', () => {
  const copy = (id: string) => `Saved. [Report](engram-artifact:${id}-report.md)`
  const first = copy('0a1b2c3d-1111-2222-3333-444455556666')
  expect(recheckAddsNothing(copy('9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff'), first)).toBe(false)
  expect(recheckAddsNothing('Saved. [Report](engram-artifact:report.md)', first)).toBe(false)
  expect(recheckAddsNothing(first, first)).toBe(true)
  expect(recheckAddsNothing(`Saved.\n[Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)\n`, first)).toBe(false)
  expect(recheckAddsNothing(`${first}\n`, first)).toBe(true)
})
// qa142 p2b-r9: folding characters or whitespace can change what a report says.
it('posts a re-check whose text differs from the report only by a compatibility form or a line break', () => {
  expect(recheckAddsNothing('The table has 106 rows.', 'The table has 10⁶ rows.')).toBe(false)
  expect(recheckAddsNothing('The table has 10⁶ rows.', 'The table has 106 rows.')).toBe(false)
  const twoLines = 'Run:\n```sh\ncd build\nrm -rf *\n```'
  expect(recheckAddsNothing('Run:\n```sh\ncd build rm -rf *\n```', twoLines)).toBe(false)
  expect(recheckAddsNothing(twoLines, 'Run:\n```sh\ncd build rm -rf *\n```')).toBe(false)
  expect(recheckAddsNothing(twoLines, twoLines)).toBe(true)
  expect(recheckAddsNothing(twoLines.replace(/\n/g, '\r\n') + '\r\n', twoLines)).toBe(true)
})
it('posts a re-check whose punctuation or dropped qualifier changes what the report said', () => {
  expect(recheckAddsNothing('No changes were made.', 'No, changes were made.')).toBe(false)
  expect(recheckAddsNothing('All tests passed.', 'All tests passed except integration tests failed.')).toBe(false)
})
it.each([
  ['No changes were made.', 'No, changes were made.'],
  ['All tests passed.', 'All tests passed except integration tests failed.'],
])('posts through the runner "%s" after "%s" though the re-check calls the report unchanged', async (answer, report) => {
  const t = await unchanged(`${report} [Report](engram-artifact:report.md)`, `${answer} [Report](engram-artifact:report.md)`)
  await t.chat('Save the report')
  expect(t.delivered).toEqual([`${answer} [Report](engram-artifact:report.md)`])
})
it('stays silent on a verbatim repeat that carries a correction word of the report itself', () => {
  const report = 'The file was not changed; nothing is wrong. 수정 없음.'
  expect(recheckAddsNothing(report, report)).toBe(true)
})
it('posts a re-check that puts a confirmation before the restated values', () => {
  expect(recheckAddsNothing('Checked again. A: 12; B: 14.', 'Saved. A: 12; B: 14.')).toBe(false)
  expect(recheckAddsNothing('checked again — **a**: １２; b: *14*.', 'Saved. A: 12; B: 14.')).toBe(false)
  expect(recheckAddsNothing('다시 확인함. 합계 12건, 오류 14건', '저장함. 합계 12건, 오류 14건')).toBe(false)
})
it('posts through the runner a swap the re-check calls unchanged', async () => {
  const swapped = 'A: 14; B: 12. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('A: 12; B: 14. [Report](engram-artifact:report.md)', 1), check: { accepted: true, issues: ['Row count not read back'], report: passed } }
    : { ...done(swapped, 1), check: { accepted: true, issues: [], report: passed, reportUnchanged: true }, trail: readback })
  await t.chat('Save the report')
  expect(t.delivered).toEqual([swapped])
})

// qa142 p2b-r5: a correction can carry no value at all; every word is compared in its place.
it('posts a re-check that changes a status word the delivered report has', () => {
  expect(recheckAddsNothing('Status: failed.', 'Status: passed.')).toBe(false)
  expect(recheckAddsNothing('테스트 실패', '테스트 통과')).toBe(false)
  expect(recheckAddsNothing('Checked again. Build: passed; tests: failed.', 'Build: failed; tests: passed.')).toBe(false)
  expect(recheckAddsNothing('No errors found.', 'Errors found.')).toBe(false)
  expect(recheckAddsNothing('오류 없음', '오류 있음')).toBe(false)
  expect(recheckAddsNothing('변경 있음', '저장함. 테스트 통과')).toBe(false)
  // p2b-r6: a word that confirms one report corrects another, so none is taken as a confirmation.
  expect(recheckAddsNothing('Rows match.', 'Rows differ.')).toBe(false)
  expect(recheckAddsNothing('No changes.', 'Changes were made.')).toBe(false)
})
it('stays silent on the repeated report and posts a status restated alone or a value-free confirmation', () => {
  const report = 'Saved. Status: passed. 테스트 통과'
  expect(recheckAddsNothing('Status: passed.', report)).toBe(false)
  expect(recheckAddsNothing('테스트 통과', report)).toBe(false)
  expect(recheckAddsNothing(report, report)).toBe(true)
  expect(recheckAddsNothing('다시 확인함. 테스트 통과', report)).toBe(false)
  expect(recheckAddsNothing('확인했어, 보고 내용 그대로야', report)).toBe(false)
  expect(recheckAddsNothing('Confirmed, unchanged.', report)).toBe(false)
  expect(recheckAddsNothing('Confirmed, the report is unchanged.', report)).toBe(false)
  expect(recheckAddsNothing('Verified again: no changes. 변경 없음, 이상 없음.', report)).toBe(false)
})
it('posts through the runner a status change the re-check calls unchanged', async () => {
  const failed = 'Status: failed. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Status: passed. [Report](engram-artifact:report.md)', 1), check: { accepted: true, issues: ['Row count not read back'], report: passed } }
    : { ...done(failed, 1), check: { accepted: true, issues: [], report: passed, reportUnchanged: true }, trail: readback })
  await t.chat('Save the report')
  expect(t.delivered).toEqual([failed])
})

// qa143 S19 (d), S31, S32: the answer was posted, then its re-check (told the person had not seen it) answered in full again, a word or two apart.
// The answer now waits for the re-check the runner starts at once, and only one of the two is posted.
it('posts only the re-check\'s answer when it rewords a report that was waiting for it', async () => {
  const draft = '보고서 최종본, 검수까지 끝났어요.\n\n[Report](engram-artifact:report.md)', final = '보고서 최종본, 검수까지 마쳐서 그대로 드려요.\n\n[Report](engram-artifact:report.md)'
  const t = await unchanged(draft, final)
  await t.chat('이어서 해줘')
  expect(t.sent).toHaveLength(2)
  expect(t.sent[0]?.extra?.verification).toBeUndefined()
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true, result: final })
  expect(t.delivered).toEqual([final])
})

it('still posts the waiting report when its re-check ends without an answer', async () => {
  const report = 'Saved. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } } : undefined)
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'failed' })
  expect(t.delivered).toEqual([report])
})
