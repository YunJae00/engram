import { expect, it } from 'vitest'
import { listTasks, TASK_TOKEN_BUDGET } from 'core'
import { done, setup, pressed } from './task-runner-fixture.js'

it.each(['Saved', '[Report](engram-artifact:report.md)'])('delivers %s without a separate verification turn', async answer => {
  const t = await setup(async () => ({ ...done(answer, 1), trail: [pressed('Save')] }))
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(1)
  expect(t.sent[0]?.extra?.verification).toBeUndefined()
  expect(t.delivered).toEqual([])
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', result: answer, turns: 1 })
})

it('allows turn thirteen while token budget remains', async () => {
  const { createTask, updateTask } = await import('core')
  const t = await setup(async () => done('Finished'))
  const task = await createTask(t.paths, 'Long job', 'bot-1')
  await updateTask(t.paths, task.id, saved => { saved.state = 'waiting'; saved.question = 'Which source?'; saved.turns = 12 })
  await t.chat('Use the supplied source')
  expect((await listTasks(t.paths))[0]).toMatchObject({ turns: 13, state: 'done' })
})

it('persists reported token usage and does not restart an exhausted task', async () => {
  const t = await setup(async () => ({ ...done('Token budget reached'), tokensUsed: TASK_TOKEN_BUDGET, budgetExhausted: true }))
  await t.chat('Long job')
  expect(t.sent).toHaveLength(1)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'failed', tokensUsed: TASK_TOKEN_BUDGET })
})

it('continues paused work only on user input and never learns it as a question answer', async () => {
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done('Source requires manual control'), unfinished: true } : done('Finished'))
  await t.chat('Read the report')
  expect(t.sent).toHaveLength(1)
  await t.chat('Use the attached copy')
  expect(await listTasks(t.paths)).toHaveLength(1)
  expect(t.sent).toHaveLength(2)
  expect(t.learned).toEqual([])
  expect(t.sent[1]?.extra?.context).toContain('Original task: Read the report')
})

it('never promotes accepted unresolved reports to verified tasks', async () => {
  const t = await setup(async () => ({ ...done('Source unavailable'),
    check: { accepted: true, verified: false, issues: ['Source grounding: unknown — HTTP 403'] },
    trail: [{ tool: 'read_open_page', args: {}, observation: 'Alternate source read' }] }))
  await t.chat('Check the source')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', verified: false, verificationIssue: expect.stringContaining('unknown') })
})

it('automatically continues unfinished reading once and completes', async () => {
  const t = await setup(async (_request, turn) => ({ ...done(turn === 1 ? 'Read the first item' : 'Finished'), unfinished: turn === 1 }))
  await t.chat('Read all items')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', turns: 2 })
  expect(t.sent[1]?.request.message).toContain('Read all items')
})
it.each(['accessibility_denied', 'requires manual control', 'Blocked by a permission or security screen', '권한 또는 보안 화면', 'sign-in', '로그인'])('waits immediately for an access barrier: %s', async reason => {
  const t = await setup(async () => ({ ...done(reason), unfinished: true }))
  await t.chat('Read all items')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', turns: 1 })
})
it('bounds changing unfinished reasons to three automatic continuations', async () => {
  const t = await setup(async (_request, turn) => ({ ...done(`Read item ${turn}`), unfinished: true }))
  await t.chat('Read all items')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', turns: 4 })
})
it('resets the continuation counter after a task completes', async () => {
  const t = await setup(async (_request, turn) => ({ ...done(`Read item ${turn}`), unfinished: turn !== 4 && turn !== 8 }))
  await t.chat('Read first set')
  await t.chat('Read second set')
  expect((await listTasks(t.paths)).every(task => task.state === 'done' && task.turns === 4)).toBe(true)
})
it('retries unresolved verification once with the verification prompt', async () => {
  const t = await setup(async () => ({ ...done('Needs readback'), check: { accepted: false, issues: ['Missing readback'] } }))
  await t.chat('Verify the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', turns: 2 })
  expect(t.sent[1]?.request.message).toContain('Verify')
})

it('waits when the verification retry provides no result check', async () => {
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done('Needs checking'), check: { accepted: false, issues: ['Missing readback'] } } : done('No check supplied'), false)
  await t.chat('Verify the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', turns: 2, verified: false, verificationIssue: 'The verification turn ended without a result check.' })
})

// qa142 p2a-r5 #4: a check turn whose checks all pass but that never read a handed-in file's final bytes gets one readback-only turn.
const unreadReport = { checks: [{ requirement: 'Leads merged', status: 'pass' as const, basis: 'Compared.' }, { requirement: 'No duplicates', status: 'pass' as const, basis: 'Counted.' }], grounding: { status: 'pass' as const, basis: 'Compared.' }, sources: [] }
const unreadCheck = { report: unreadReport, accepted: false, verified: false, issues: ['Reread every final part of check_merge.py (/artifacts/id-check_merge.py) after its last write: the whole text at one revision.'], readbacks: [{ name: 'check_merge.py', path: '/artifacts/id-check_merge.py' }] }
const fileRead = { tool: 'file_read', args: { path: '/artifacts/id-check_merge.py' }, observation: '{"path":"/artifacts/id-check_merge.py","sha256":"x","content":"print(0)"}' }
const report = 'Compared with check_merge.py: 0 mismatches.\n\n[merged.md](engram-artifact:merged.md)\n\n[check_merge.py](engram-artifact:check_merge.py)'

it('gives a check turn that lacks only handed-in readbacks one readback-only turn, and ends done once they are read', async () => {
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done(report, 1), check: unreadCheck, trail: [pressed('Save')] }
    : turn === 2 ? { ...done(report, 1), check: unreadCheck, trail: [fileRead] }
    : { ...done(report, 1), check: { accepted: true, verified: true, issues: [], reportUnchanged: true }, trail: [fileRead] }, false)
  await t.chat('Merge the leads')
  const task = (await listTasks(t.paths))[0]!
  expect(task).toMatchObject({ state: 'done', turns: 3, verified: true })
  expect(task.verificationIssue).toBeUndefined()
  expect(task.log.map(entry => entry.line)).toContain('Reading back the handed-in files once')
  // The ordinary check retry comes first; the third turn is the readback only.
  expect(t.sent[1]?.extra?.verification).toEqual({ result: report })
  // qa142 p2a-r6 #2: it is held to the preceding report's own requirement checks.
  expect(t.sent[2]?.extra?.verification).toEqual({ result: report, readback: true, requirements: ['Leads merged', 'No duplicates'] })
  expect(t.sent[2]!.request.message).toContain('- Leads merged\n- No duplicates')
  const prompt = t.sent[2]!.request.message
  expect(prompt).toContain('- check_merge.py: /artifacts/id-check_merge.py')
  expect(prompt).toContain('call report_result_check again')
  expect(prompt).toContain('Do no other work')
  expect(prompt).toContain('Merge the leads')
  // The report reached the person once; the readback turn that confirms it adds no second message.
  expect(t.delivered).toEqual([report])
})

it('holds the readback-only turn to the model\'s own requirement checks, not to the entries the host added for the unread files', async () => {
  const hostEntry = { requirement: 'Unresolved verification', status: 'unknown' as const, basis: 'Reread every final part of check_merge.py.' }
  const t = await setup(async () => ({ ...done(report, 1), check: { ...unreadCheck, report: { ...unreadReport, checks: [...unreadReport.checks, hostEntry] } }, trail: [fileRead] }), false)
  await t.chat('Merge the leads')
  expect(t.sent[2]?.extra?.verification).toEqual({ result: report, readback: true, requirements: ['Leads merged', 'No duplicates'] })
  expect(t.sent[2]!.request.message).not.toContain('- Unresolved verification')
})

// qa142 p2a-r7 #1: the readback-only turn is held to every requirement any report of the task stated, not only the preceding report's.
it.each([[['Leads merged'], false], [['Leads merged', ' no  duplicates '], true]] as const)('holds the readback-only turn to a requirement the retry dropped: restating %j verifies %s', async (restated, verified) => {
  const checks = (names: readonly string[]) => names.map(requirement => ({ requirement, status: 'pass' as const, basis: 'Compared.' }))
  const t = await setup(async (_request, turn, extra) => {
    // First report: both. Retry: only the first, still lacking the readback. Readback turn: the host's check, which takes the handed list as required.
    if (turn < 3) return { ...done(report, 1), check: { ...unreadCheck, report: { ...unreadReport, checks: checks(turn === 1 ? ['Leads merged', 'No duplicates'] : ['Leads merged']) } }, trail: [fileRead] }
    const same = (text: string) => text.trim().replace(/\s+/g, ' ').toLowerCase()
    const missing = (extra?.verification?.requirements ?? []).filter(required => !restated.some(one => same(one) === same(required)))
    return { ...done(report, 1), check: { accepted: !missing.length, verified: !missing.length, issues: missing.map(one => `left out: ${one}`), report: { ...unreadReport, checks: checks(restated) }, reportUnchanged: true }, trail: [fileRead] }
  }, false)
  await t.chat('Merge the leads')
  expect(t.sent[2]?.extra?.verification).toEqual({ result: report, readback: true, requirements: ['Leads merged', 'No duplicates'] })
  expect(t.sent[2]!.request.message).toContain('- Leads merged\n- No duplicates')
  expect((await listTasks(t.paths))[0]).toMatchObject(verified ? { state: 'done', verified: true, turns: 3 } : { state: 'waiting', verified: false, turns: 3 })
})

it('ends waiting when the readback-only turn still lacks the readback, and never gives a second one', async () => {
  const t = await setup(async () => ({ ...done(report, 1), check: unreadCheck, trail: [fileRead] }), false)
  await t.chat('Merge the leads')
  const task = (await listTasks(t.paths))[0]!
  expect(task).toMatchObject({ state: 'waiting', turns: 3, verified: false, verificationIssue: expect.stringContaining('Reread every final part of check_merge.py') })
  expect(t.sent).toHaveLength(3)
  expect(task.log.at(-1)!.line).toBe('The report is recorded, but unresolved checks remain. Waiting for your next instruction.')
})

it.each([
  ['a requirement is unresolved too', { ...unreadCheck, issues: [...unreadCheck.issues, 'Leads merged: unknown — not compared'] }],
  ['the unread file is not a hand-in', { accepted: false, verified: false, issues: unreadCheck.issues }],
])('gives no readback-only turn when %s', async (_why, check) => {
  const t = await setup(async () => ({ ...done(report, 1), check, trail: [fileRead] }), false)
  await t.chat('Merge the leads')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', turns: 2, verified: false })
  expect(t.sent.every(one => !one.extra?.verification?.readback)).toBe(true)
})
