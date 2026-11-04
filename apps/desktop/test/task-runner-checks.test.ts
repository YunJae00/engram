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
