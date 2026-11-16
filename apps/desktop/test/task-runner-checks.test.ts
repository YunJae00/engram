import { expect, it } from 'vitest'
import { join } from 'node:path'
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
  expect(t.sent[1]?.extra?.verification).toEqual({ goal: 'Merge the leads', result: report })
  // qa142 p2a-r8 A: it is not held to a requirement list; the check turn's report stands and this turn only adds the reads.
  expect(t.sent[2]?.extra?.verification).toEqual({ goal: 'Merge the leads', result: report, readback: true })
  expect(t.sent[2]!.request.message).not.toContain('- Leads merged')
  expect(t.sent[2]!.request.message).toContain('The requirement checks you already reported stand as they are')
  const prompt = t.sent[2]!.request.message
  expect(prompt).toContain('- check_merge.py: /artifacts/id-check_merge.py')
  expect(prompt).toContain('call report_result_check again')
  expect(prompt).toContain('Do no other work')
  expect(prompt).toContain('Merge the leads')
  // The report reached the person once; the readback turn that confirms it adds no second message.
  expect(t.delivered).toEqual([report])
})

it('hands the readback-only turn no requirement list, neither the model\'s own checks nor the entries the host added for the unread files', async () => {
  const hostEntry = { requirement: 'Unresolved verification', status: 'unknown' as const, basis: 'Reread every final part of check_merge.py.' }
  const t = await setup(async () => ({ ...done(report, 1), check: { ...unreadCheck, report: { ...unreadReport, checks: [...unreadReport.checks, hostEntry] } }, trail: [fileRead] }), false)
  await t.chat('Merge the leads')
  expect(t.sent[2]?.extra?.verification).toEqual({ goal: 'Merge the leads', result: report, readback: true })
  expect(t.sent[2]!.request.message).not.toContain('- Unresolved verification')
})

// qa142 p2a-r8 A: the readback-only turn does not re-judge requirements. Whatever checks its report restates, the check turn's report is carried over and only the reads decide.
it.each([[['Leads merged']], [['Leads merged', ' no  duplicates ']], [[]]] as const)('verifies a readback-only turn that adds the reads and restates only %j', async restated => {
  const checks = (names: readonly string[]) => names.map(requirement => ({ requirement, status: 'pass' as const, basis: 'Compared.' }))
  const t = await setup(async (_request, turn) => {
    // First report: both. Retry: only the first, still lacking the readback. Readback turn: the reads, and a report with fewer checks.
    if (turn < 3) return { ...done(report, 1), check: { ...unreadCheck, report: { ...unreadReport, checks: checks(turn === 1 ? ['Leads merged', 'No duplicates'] : ['Leads merged']) } }, trail: [fileRead] }
    return { ...done(report, 1), check: { accepted: true, verified: true, issues: [], report: { ...unreadReport, checks: checks(restated) }, reportUnchanged: true }, trail: [fileRead] }
  }, false)
  await t.chat('Merge the leads')
  expect(t.sent[2]?.extra?.verification).toEqual({ goal: 'Merge the leads', result: report, readback: true })
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true, turns: 3 })
  // The carried report passed, so the confirming readback adds no second message.
  expect(t.delivered).toEqual([report])
})

// A waiting task keeps no requirement list: the person's next instruction starts a normal turn judged by its own report.
it('demands no earlier requirement when the person instructs a task left waiting after its readback-only turn', async () => {
  const t = await setup(async (_request, turn) => turn <= 3 ? { ...done(report, 1), check: unreadCheck, trail: [fileRead] }
    : { ...done('Only the count now: 12.', 1), check: { accepted: true, verified: true, issues: [], report: { ...unreadReport, checks: [{ requirement: 'Count reported', status: 'pass' as const, basis: 'Counted.' }] } }, trail: [fileRead] }, false)
  await t.chat('Merge the leads')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'waiting', turns: 3, verified: false })
  await t.chat('Forget the duplicates check, just report the count')
  expect(await listTasks(t.paths)).toHaveLength(1)
  expect(t.sent).toHaveLength(4)
  expect(t.sent[3]?.extra?.verification).toBeUndefined()
  expect(t.sent[3]!.request.message).not.toContain('No duplicates')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true, turns: 4 })
})

// qa142 p2a-r9 #2: the host, not the prompt, keeps the follow-up to reading: one that changed a result is not accepted, even with every listed file read and a passing check.
it.each([
  ['writes a file with its own tool', { tool: 'Write', args: { file_path: '/task/check_merge.py', content: 'print(1)' }, observation: 'Native action completed.', committed: true }],
  ['saves a new copy', { tool: 'file_create_copy', args: { name: 'check_merge.py', content: 'print(1)' }, observation: '{"path":"/artifacts/id2-check_merge.py","sha256":"y"}' }],
  ['renders a file', { tool: 'render_file', args: { name: 'report.pdf', html: '<p>x</p>' }, observation: '{"path":"/artifacts/id-report.pdf","sha256":"z","completeReadback":true}' }],
  ['changes a task file by command that the host then hands in', { tool: 'file_create_copy', args: { name: 'check_merge.py', fromPath: 'check_merge.py' }, observation: '{"path":"/artifacts/id2-check_merge.py","sha256":"y","handedInFrom":"/task/check_merge.py"}' }],
  // qa143 p2 r4 #1 (B14): a command that may have written a file is a change here too, by the rule freshness and the post-check list use.
  ['rewrites the file with a script', { tool: 'Bash', args: { command: 'python3 rewrite.py' }, observation: 'ok' }],
  ['rewrites the file with a redirect', { tool: 'Bash', args: { command: 'cat fixed.py > check_merge.py' }, observation: '' }],
  ['edits the file in place by command', { tool: 'Shell', args: { command: 'sed -i s/0/1/ check_merge.py' }, observation: '' }],
  ['runs a script that failed part-way', { tool: 'Bash', args: { command: 'python3 rewrite.py' }, observation: 'that did not work: exit 1' }],
])('ends waiting unverified when the readback-only turn %s and reads it back, and gives no further follow-up', async (_what, change) => {
  const t = await setup(async (_request, turn) => turn < 3 ? { ...done(report, 1), check: unreadCheck, trail: [fileRead] }
    : { ...done(report, 1), check: { accepted: true, verified: true, issues: [], reportUnchanged: true }, trail: [change, fileRead] }, false)
  await t.chat('Merge the leads')
  const task = (await listTasks(t.paths))[0]!
  expect(t.sent[2]?.extra?.verification).toEqual({ goal: 'Merge the leads', result: report, readback: true })
  expect(task).toMatchObject({ state: 'waiting', turns: 3, verified: false, verificationIssue: expect.stringContaining('readback-only turn changed the result') })
  expect(t.sent).toHaveLength(3)
  expect(task.log.at(-1)!.line).toBe('The report is recorded, but unresolved checks remain. Waiting for your next instruction.')
})

// A write that did not happen changed nothing: the follow-up that then only read is still verified.
it('verifies a readback-only turn whose only write attempt failed', async () => {
  const failed = { tool: 'Write', args: { file_path: '/task/check_merge.py', content: 'print(1)' }, observation: 'that did not work: Native action did not report success; it may have partly happened.', committed: true }
  const t = await setup(async (_request, turn) => turn < 3 ? { ...done(report, 1), check: unreadCheck, trail: [fileRead] }
    : { ...done(report, 1), check: { accepted: true, verified: true, issues: [], reportUnchanged: true }, trail: [failed, fileRead] }, false)
  await t.chat('Merge the leads')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true, turns: 3 })
})

// A plain reader command changed nothing: the follow-up that compared and read is still verified.
it('verifies a readback-only turn that only ran plain reader commands', async () => {
  const readers = [{ tool: 'Bash', args: { command: 'diff merged.md leads.md; cat check_merge.py | wc -l' }, observation: '1' }]
  const t = await setup(async (_request, turn) => turn < 3 ? { ...done(report, 1), check: unreadCheck, trail: [fileRead] }
    : { ...done(report, 1), check: { accepted: true, verified: true, issues: [], reportUnchanged: true }, trail: [...readers, fileRead] }, false)
  await t.chat('Merge the leads')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true, turns: 3 })
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

// qa143 B14: two leads' text was merged, compared item by item and checked with every requirement passing, yet the turn ended
// "작업이 멈췄어요 / 일부를 확인하지 못했어요": the check turn had no readback step, and a report of words alone has nothing to read back.
const hireLeads = async (paths: Parameters<typeof listTasks>[0]) => {
  const { updateTask } = await import('core')
  const task = (await listTasks(paths))[0]!
  await updateTask(paths, task.id, saved => { saved.team = { members: [{ id: 'm1', parentId: null, depth: 1, role: '규정 팀장', brief: '', deliverable: '', state: 'released', sessionKey: 'team-m1', hiredAt: new Date().toISOString(), result: '규정 5개', review: { ok: true, note: '' } }], hires: 1, maxHires: 8, maxDepth: 3, big: false } })
}
const compared = [{ tool: 'Bash', args: { command: 'diff .check/a .check/b' }, observation: 'MATCH' }, { tool: 'report_result_check', args: {}, observation: '{"validation":{"accepted":true,"verified":true,"issues":[]}}' }]
const passed = { accepted: true, verified: true, issues: [] }

it('ends a self-checked team report of words alone as done', async () => {
  const t = await setup(async (_request, turn) => {
    if (turn === 1) { await hireLeads(t.paths); return done('규정 5개와 체크리스트 10개예요.', 1) }
    return { ...done('규정 5개와 체크리스트 10개예요.', 2), check: passed, trail: compared }
  }, false)
  await t.chat('팀장 2명 뽑아서 합쳐서 보고해줘')
  const task = (await listTasks(t.paths))[0]!
  expect(t.sent).toHaveLength(2)
  expect(t.sent[1]?.extra?.verification).toBeTruthy()
  expect(task).toMatchObject({ state: 'done', verified: true, turns: 2 })
  expect(task.verificationIssue).toBeUndefined()
  expect(task.log.at(-1)!.line).toBe('Done')
  // qa143 S31/S32: the merged report was posted, then posted again by its check. It is posted once.
  expect(t.delivered).toEqual(['규정 5개와 체크리스트 10개예요.'])
})

it.each([
  ['hands over a file', '[보고서](engram-artifact:report.md)', [] as typeof compared],
  ['changed a file earlier in the task', '규정 5개와 체크리스트 10개예요.', [{ tool: 'Write', args: { file_path: '/task/report.md' }, observation: 'Native action completed.' }]],
  // qa143 p2 r2 #3: a command that wrote a task file is a change like any other write.
  ['wrote a file with a command earlier in the task', '규정 5개와 체크리스트 10개예요.', [{ tool: 'Bash', args: { command: 'cat > report.md <<EOF\n규정 5개\nEOF' }, observation: 'Native action completed.' }]],
  ['ran a script earlier in the task', '규정 5개와 체크리스트 10개예요.', [{ tool: 'Bash', args: { command: 'python3 build_report.py' }, observation: 'Native action completed.' }]],
])('still leaves a team report that %s unverified when its check turn read nothing back', async (_why, answer, earlier) => {
  const t = await setup(async (_request, turn) => {
    if (turn === 1) { await hireLeads(t.paths); return { ...done(answer, 1), trail: earlier } }
    return { ...done(answer, 2), check: passed, trail: compared }
  }, false)
  await t.chat('팀장 2명 뽑아서 합쳐서 보고해줘')
  const task = (await listTasks(t.paths))[0]!
  expect(task).toMatchObject({ state: 'waiting', verified: false, verificationIssue: 'The result has no fresh readback.' })
  expect(task.log.at(-1)!.line).toBe('The report is recorded, but unresolved checks remain. Waiting for your next instruction.')
})

// qa143 S19 (b): the report existed and its check had passed every requirement; the automatic re-check then ran out of the task's
// token budget, and the task ended failed with "작업이 처리 한도에 닿아 끝나지 않았어요" and the budget text as its result.
// qa143 p2 r3 #1: the production shape. The core returns every budget stop as incomplete, which ipc reports as unfinished with the budget note as its reason.
const budgetStop = { answer: 'The task token budget (56,032 new tokens available for this turn) was reached. Work so far is preserved; inspect the current state before continuing.', asked: false, unfinished: true, unfinishedReason: 'The task token budget (56,032 new tokens available for this turn) was reached.', steps: 1, budgetExhausted: true, tokensUsed: 56_032 }
// qa143 p2 r2 #1: only the host's own verdict lets the report stand: the re-check read the files back and its check was accepted before the budget ran out.
const hostAccepted = { accepted: true, verified: true, issues: [], report: unreadReport }
it('finishes with the checked report when only its re-check ran out of budget', async () => {
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done(report, 1), tokensUsed: 240_000, check: unreadCheck, trail: [fileRead] } : { ...budgetStop, check: hostAccepted, trail: [fileRead] }, false)
  await t.chat('Merge the leads')
  const task = (await listTasks(t.paths))[0]!
  expect(t.sent).toHaveLength(2)
  expect(t.sent[1]?.extra?.verification).toEqual({ goal: 'Merge the leads', result: report })
  expect(task).toMatchObject({ state: 'done', result: report, turns: 2, verified: true })
  expect(task.verificationIssue).toBeUndefined()
  expect(task.log.at(-1)!.line).toBe('Done; the re-check stopped at the task token budget.')
  // The report, which waited for that re-check, is posted once; the budget text is not, and there is no limit-stop closing.
  expect(t.delivered).toEqual([report])
  expect(JSON.stringify(t.events)).not.toMatch(/처리 한도|processing limit|token budget/)
})

// qa143 p2 r7 S19b: the re-check made another report.md, read both files in full and stopped at the budget, so the earlier report rightly
// stood as done; but it was posted with the re-check's steps, and the host pointed its link at the newer report.md (newestRevisions).
it('posts the report restored at a budget stop with its own file, not a same-name file made in the re-check', async () => {
  const { saveArtifact } = await import('core')
  const { latestResultOutputs } = await import('../src/main/result-check.js')
  const { newestRevisions } = await import('../src/main/file-work.js')
  let directory = '', own = '', since = 0
  const read = (path: string) => ({ tool: 'file_read', args: { path }, observation: JSON.stringify({ path, sha256: 'x', content: 'x' }) })
  const t = await setup(async (_request, turn) => {
    if (turn === 1) {
      directory = join(t.paths.cache, 'artifacts'); since = Date.now() - 1000
      const first = await saveArtifact(directory, 'report.md', Buffer.from('# Report\n'))
      own = `Report written.\n\n${first.markdownLink}`
      return { ...done(own, 1), tokensUsed: 240_000, check: unreadCheck, trail: [read(first.path)] }
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = await saveArtifact(directory, 'report.md', Buffer.from('# Another report\n'))
    const made = { tool: 'file_create_copy', args: { name: 'report.md', content: '# Another report\n' }, observation: JSON.stringify(second) }
    return { ...budgetStop, check: hostAccepted, trail: [made, read(second.path), fileRead] }
  }, false)
  await t.chat('Write the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', result: own, verified: true })
  expect(t.delivered).toEqual([own])
  // As ipc.ts deliver does with the trail it is handed.
  expect(await newestRevisions(directory, own, since, latestResultOutputs(t.deliveredTrails[0]!, []).map(output => output.path))).toBe(own)
})

it.each([
  ['its check left a requirement unresolved', { ...unreadCheck, report: { ...unreadReport, checks: [{ requirement: 'Leads merged', status: 'unknown' as const, basis: 'Not compared.' }] } }],
  ['it had no check of its own', undefined],
  // qa143 p2 r2 #1: the model's pass labels alone do not finish a report the host rejected for an unread final file.
  ['the host rejected it for a missing readback and the re-check reported nothing', unreadCheck],
  ['the re-check\'s accepted check read nothing back', unreadCheck, { ...budgetStop, check: hostAccepted, trail: [] }],
  ['the re-check still left the readback open', unreadCheck, { ...budgetStop, check: unreadCheck, trail: [fileRead] }],
  ['the re-check left a requirement unresolved', unreadCheck, { ...budgetStop, check: { accepted: true, verified: false, issues: ['Leads merged: unknown'] }, trail: [fileRead] }],
] as const)('still stops at the budget when the report was not checked: %s', async (_why, check, stop = budgetStop) => {
  const t = await setup(async (_request, turn, extra) => {
    if (turn === 1 && !check) { await hireLeads(t.paths); return { ...done(report, 1), tokensUsed: 240_000 } }
    return turn === 1 ? { ...done(report, 1), tokensUsed: 240_000, check, trail: [fileRead] } : extra?.verification ? stop : done(report, 1)
  }, false)
  await t.chat('Merge the leads')
  const task = (await listTasks(t.paths))[0]!
  expect(task).toMatchObject({ state: 'failed', result: budgetStop.answer })
  expect(task.verified).not.toBe(true)
  expect(task.log.at(-1)!.line).toBe('Stopped at the task token budget.')
})

it('still stops a working turn at the budget', async () => {
  const t = await setup(async () => budgetStop, false)
  await t.chat('Merge the leads')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'failed', result: budgetStop.answer })
})
