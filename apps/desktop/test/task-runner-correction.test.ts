import { expect, it, vi } from 'vitest'
import { createTask, listTasks, readBotTranscript, updateTask } from 'core'
import { done, setup } from './task-runner-fixture.js'
import { recheckAddsNothing } from '../src/main/task-runner.js'

it('preserves the engine answer and reported limitations through one verification retry', async () => {
  const answer = 'Updated the report. The external source is unavailable.'
  const t = await setup(async () => ({ ...done(answer, 1), check: { accepted: false, issues: ['Source unavailable'] } }))
  await t.chat('Update the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]?.result).toBe(answer)
})

const unchanged = (report: string, answer: string) => setup(async (_request, turn) => turn === 1
  ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } }
  : { ...done(answer, 1), check: { accepted: true, issues: [], reportUnchanged: true }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
it('reports once when the re-check passes and repeats the report', async () => {
  const report = 'Saved. [Report](engram-artifact:report.md)'
  const t = await unchanged(report, report)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([report])
})
it('posts after the report a re-check that confirms in words the report lacks', async () => {
  const confirmed = 'Checked again; all rows match. [Report](engram-artifact:report.md)'
  const t = await unchanged('Saved. [Report](engram-artifact:report.md)', confirmed)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual(['Saved. [Report](engram-artifact:report.md)', confirmed])
})
it.each([
  ['Rows match.', 'Rows differ.'],
  ['No changes.', 'Changes were made.'],
])('posts through the runner "%s" after "%s" though the re-check calls the report unchanged', async (answer, report) => {
  const t = await unchanged(`${report} [Report](engram-artifact:report.md)`, `${answer} [Report](engram-artifact:report.md)`)
  await t.chat('Save the report')
  expect(t.delivered).toEqual([`${report} [Report](engram-artifact:report.md)`, `${answer} [Report](engram-artifact:report.md)`])
})
it('still reports what a re-check changed', async () => {
  const fixed = 'Fixed one row. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Saved. [Report](engram-artifact:report.md)', 1), check: { accepted: false, issues: ['Row 3 differs'] } }
    : { ...done(fixed, 2), check: { accepted: true, issues: [] }, trail: [{ tool: 'file_create_copy', args: {}, observation: '{}' }, { tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done' })
  expect(t.delivered).toEqual(['Saved. [Report](engram-artifact:report.md)', fixed])
})

it('posts a re-check that passes a requirement the delivered report had left failed, though it changed no file', async () => {
  const corrected = 'The total is 14, not 12 as I said. [Report](engram-artifact:report.md)'
  const verdict = (status: 'pass' | 'fail') => ({ checks: [{ requirement: 'Total matches the source', status, basis: 'Compared with the source' }], grounding: { status: 'pass' as const, basis: 'Read the source' }, sources: [] })
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Saved; the total is 12. [Report](engram-artifact:report.md)', 1), check: { accepted: true, verified: false, issues: ['Total matches the source: fail'], report: verdict('fail') } }
    : { ...done(corrected, 1), check: { accepted: true, issues: [], report: verdict('pass') }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual(['Saved; the total is 12. [Report](engram-artifact:report.md)', corrected])
})
it('posts a re-check that hands over a different file than the report did', async () => {
  const other = 'The checked file is this one. [Final](engram-artifact:final.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Saved. [Report](engram-artifact:report.md)', 1), check: { accepted: false, issues: ['Row count not read back'] } }
    : { ...done(other, 1), check: { accepted: true, issues: [] }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect(t.delivered).toEqual(['Saved. [Report](engram-artifact:report.md)', other])
})
it('posts a confirming re-check in its own words that links the same file under its saved-copy id', async () => {
  const confirmed = 'All rows match. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)'
  const t = await unchanged('Saved. [Report](engram-artifact:report.md)', confirmed)
  await t.chat('Save the report')
  expect(t.delivered).toEqual(['Saved. [Report](engram-artifact:report.md)', confirmed])
})
it('posts a re-check that repeats the report with the file under its saved-copy id', async () => {
  const answer = 'Saved. [Report](engram-artifact:0a1b2c3d-1111-2222-3333-444455556666-report.md)'
  const t = await unchanged('Saved. [Report](engram-artifact:report.md)', answer)
  await t.chat('Save the report')
  expect(t.delivered).toEqual(['Saved. [Report](engram-artifact:report.md)', answer])
})

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
  expect(t.delivered).toEqual(['Saved; the total is 12. [Report](engram-artifact:report.md)', corrected])
})
it('posts a passing re-check that does not say the report is unchanged', async () => {
  const again = 'Checked again. [Report](engram-artifact:report.md)'
  const t = await recheck(again)
  await t.chat('Save the report')
  expect(t.delivered).toEqual(['Saved; the total is 12. [Report](engram-artifact:report.md)', again])
})
it('posts after the report a confirm-only re-check that affirms the report is unchanged in words of its own', async () => {
  const confirmed = 'Checked again; the total is 12. [Report](engram-artifact:report.md)'
  const t = await recheck(confirmed, true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual(['Saved; the total is 12. [Report](engram-artifact:report.md)', confirmed])
})
it('posts after the report a re-check that restates only part of the report and affirms it is unchanged', async () => {
  const part = 'The total is 12. [Report](engram-artifact:report.md)'
  const t = await recheck(part, true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual(['Saved; the total is 12. [Report](engram-artifact:report.md)', part])
})
it('posts after the report a re-check that repeats the report, rewrapped, though it affirms it is unchanged', async () => {
  const rewrapped = 'Saved; the total\nis 12.\n\n[Report](engram-artifact:report.md)\n'
  const t = await recheck(rewrapped, true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual(['Saved; the total is 12. [Report](engram-artifact:report.md)', rewrapped])
})
it('posts after the report a re-check that repeats the report, rewrapped and emphasised, though it affirms it is unchanged', async () => {
  const emphasised = '**Saved;** the total\nis ~~12~~.\n\n[Report](engram-artifact:report.md)'
  const t = await recheck(emphasised, true)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual(['Saved; the total is 12. [Report](engram-artifact:report.md)', emphasised])
})

it.each([
  ['an English correction', 'The total is 14, not 12 as I said. [Report](engram-artifact:report.md)'],
  ['a Korean correction', '합계는 12가 아니라 14야. [Report](engram-artifact:report.md)'],
  ['a number the report lacks', 'Checked again; the total is 12 across 37 rows. [Report](engram-artifact:report.md)'],
])('posts a re-check with %s though it says the report is unchanged', async (_name, answer) => {
  const t = await recheck(answer, true)
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual(['Saved; the total is 12. [Report](engram-artifact:report.md)', answer])
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
  expect(t.delivered).toEqual([`${report} [Report](engram-artifact:report.md)`, `${answer} [Report](engram-artifact:report.md)`])
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
  expect(t.delivered).toEqual(['A: 12; B: 14. [Report](engram-artifact:report.md)', swapped])
})

it('posts a re-check that changes a status word the delivered report has', () => {
  expect(recheckAddsNothing('Status: failed.', 'Status: passed.')).toBe(false)
  expect(recheckAddsNothing('테스트 실패', '테스트 통과')).toBe(false)
  expect(recheckAddsNothing('Checked again. Build: passed; tests: failed.', 'Build: failed; tests: passed.')).toBe(false)
  expect(recheckAddsNothing('No errors found.', 'Errors found.')).toBe(false)
  expect(recheckAddsNothing('오류 없음', '오류 있음')).toBe(false)
  expect(recheckAddsNothing('변경 있음', '저장함. 테스트 통과')).toBe(false)
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
  expect(t.delivered).toEqual(['Status: passed. [Report](engram-artifact:report.md)', failed])
})

it('posts the re-check\'s answer after the report when it rewords it', async () => {
  const draft = '보고서 최종본, 검수까지 끝났어요.\n\n[Report](engram-artifact:report.md)', final = '보고서 최종본, 검수까지 마쳐서 그대로 드려요.\n\n[Report](engram-artifact:report.md)'
  const t = await unchanged(draft, final)
  await t.chat('이어서 해줘')
  expect(t.sent).toHaveLength(2)
  expect(t.sent[0]?.extra?.verification).toBeUndefined()
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true, result: final })
  expect(t.delivered).toEqual([draft, final])
})

it('still posts the waiting report when its re-check ends without an answer', async () => {
  const report = 'Saved. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } } : undefined)
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', result: report })
  expect(t.delivered).toEqual([report])
  expect(t.events.filter(e => e.type === 'chat:error')).toEqual([])
  expect((await readBotTranscript(t.paths, 'bot-1')).filter(turn => turn.error)).toEqual([])
})

it('keeps a delivered answer and adds no error line when its hidden re-check throws', async () => {
  const answer = '화분 물주기 일정표를 만들었어요. [물주기](engram-artifact:watering.xlsx)'
  const t = await setup(async (_request, turn) => {
    if (turn === 1) return { ...done(answer, 1), check: { accepted: false, issues: ['Schedule rows not read back'] } }
    throw new Error('socket hang up')
  })
  await t.chat('베란다 화분 물주기 일정표 엑셀로 만들고 한 번 더 확인해줘')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', result: answer })
  expect(t.delivered).toEqual([answer])
  expect(t.events.filter(e => e.type === 'chat:error')).toEqual([])
  expect((await readBotTranscript(t.paths, 'bot-1')).filter(turn => turn.error)).toEqual([])
})

it('still shows the usage line when a task fails before any answer was delivered', async () => {
  const t = await setup(async (_request, turn) => {
    if (turn === 1) return { ...done('', 1), unfinished: true, unfinishedReason: 'List not built yet' }
    throw new Error('socket hang up')
  })
  await t.chat('주간 장보기 목록 정리해줘')
  await t.settle('failed')
  expect(t.delivered).toEqual([])
  expect(t.events.filter(e => e.type === 'chat:error')).toHaveLength(1)
})

it('posts the report the moment it is written, so a restart during its re-check has nothing left to post', async () => {
  const report = 'Billed 7 invoices. [Invoices](engram-artifact:invoices.xlsx)'
  const first = await setup(async (_request, turn) => turn === 1 ? { ...done(report, 1), check: { accepted: false, issues: ['Invoice count not read back'] } } : new Promise<never>(() => {}), false)
  void first.chat('Bill this month\'s invoices').catch(() => undefined)
  await vi.waitFor(() => expect(first.sent).toHaveLength(2))
  expect(first.delivered).toEqual([report])
  expect(first.sent[1]?.extra?.verification).toBeDefined()
  const next = await setup(async () => undefined, false, undefined, undefined, first.paths)
  await next.runner.resume()
  expect(next.delivered).toEqual([])
  expect((await listTasks(next.paths))[0]).toMatchObject({ state: 'waiting' })
})
it('posts once, on resume, a draft an older version saved off screen while its re-check ran', async () => {
  const draft = '분기 출장비는 4건, 합계 86만 원이에요. [정산표](engram-artifact:trips.xlsx)'
  const first = await setup(async () => undefined, false)
  const task = await createTask(first.paths, '분기 출장비 정산해줘', 'bot-1')
  await updateTask(first.paths, task.id, x => { x.state = 'running'; x.unshown = draft })
  const next = await setup(async () => undefined, false, undefined, undefined, first.paths)
  await next.runner.resume()
  expect(next.delivered).toEqual([draft])
  expect((await listTasks(next.paths))[0]).toMatchObject({ state: 'waiting' })
  expect((await listTasks(next.paths))[0]?.unshown).toBeUndefined()
  await next.runner.resume()
  expect(next.delivered).toEqual([draft])
})
it('posts once an answer whose task then waits', async () => {
  const report = 'Merged both leads.'
  const t = await setup(async (request, _turn, _extra, runner) => {
    await runner.askFor(request.channel!, async () => 'approve', 0)!({ words: 'Send', url: 'https://example.test/draft' })
    return { ...done(report, 1), trail: [{ tool: 'hire_members', args: {}, observation: 'Hired two leads.' }] }
  }, false)
  void t.chat('Merge the leads').catch(() => undefined)
  await vi.waitFor(async () => expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting' }))
  await vi.waitFor(() => expect(t.delivered).toEqual([report]))
})

it.each([
  ['confirms it', { ...done('Saved 12 rows. [Report](engram-artifact:report.md)', 1), check: { accepted: true, issues: [], reportUnchanged: true }, trail: [{ tool: 'file_read', args: {}, observation: '{}' }] }, 'done'],
  ['leaves its check unresolved', { ...done('I could not verify it.', 1), check: { accepted: false, issues: ['Row count not read back'] } }, 'waiting'],
])('posts the report once, and the re-check only when it adds something, once its re-check %s', async (_why, recheck, state) => {
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done('Saved 12 rows. [Report](engram-artifact:report.md)', 1), check: { accepted: false, issues: ['Row count not read back'] } } : recheck, false)
  await t.chat('Save the report')
  const task = (await listTasks(t.paths))[0]!
  expect(task.state).toBe(state)
  await t.runner.resume()
  expect(t.delivered).toHaveLength(state === 'done' ? 1 : 2)
})

it.each([
  ['reports no result check', (note: string) => done(note, 2), 'The verification turn ended without a result check.'],
  ['leaves its check unresolved', (note: string) => ({ ...done(note, 2), check: { accepted: false, issues: ['Row count not read back'] } }), 'Row count not read back'],
  ['stops unfinished', (note: string) => ({ ...done(note, 2), unfinished: true, unfinishedReason: 'sign-in' }), undefined],
])('posts the waiting report and then the note of a re-check that %s', async (_why, recheck, issue) => {
  const report = 'Saved 12 rows. [Report](engram-artifact:report.md)', note = 'I could not verify it.'
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } } : recheck(note), false)
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  const task = (await listTasks(t.paths))[0]!
  expect(task).toMatchObject({ state: 'waiting' })
  if (issue) expect(task).toMatchObject({ verified: false, verificationIssue: issue })
  expect(t.delivered).toEqual([report, note])
})

it('posts once a waiting report its unconfirming re-check restates character for character', async () => {
  const report = 'Saved 12 rows. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } } : done(`${report}\r\n`, 2), false)
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', verified: false })
  expect(t.delivered).toEqual([report])
})
