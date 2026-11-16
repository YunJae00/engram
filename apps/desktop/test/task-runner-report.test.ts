import { expect, it, vi } from 'vitest'
import { listTasks, logTask, updateTask, type TaskTeam, type TeamMember } from 'core'
import { done, setup } from './task-runner-fixture.js'
import { awaitingEmployees } from '../src/shared/task-waits.js'

// Work the chief of staff handed to employees in the background (assign with wait false): the task waits for their report, not for the person.
const employee = (state: TeamMember['state'], more: Partial<TeamMember> = {}): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '김대리', brief: '행사 일정 정리', botId: 'kim', lookup: true, background: true, state, sessionKey: 'team-x-m1', hiredAt: new Date().toISOString(), ...more })
const teamOf = (...members: TeamMember[]): TaskTeam => ({ members, hires: members.length, maxHires: 8, maxDepth: 3, big: false })
type World = Awaited<ReturnType<typeof setup>>
const first = async (s: World) => (await listTasks(s.paths))[0]!
const seed = async (s: World, team: TaskTeam) => updateTask(s.paths, (await listTasks(s.paths)).at(-1)!.id, t => { t.team = team })
const finishMember = async (s: World) => updateTask(s.paths, (await first(s)).id, t => { Object.assign(t.team!.members[0]!, { state: 'done', result: '11월 20일 서울 AI 서밋 https://example.com/summit' }) })

it('a hand-off ends the turn on the ack, leaves the thread free, and the report comes back as one turn of its own', async () => {
  const s: World = await setup(async (request, turn, extra) => {
    if (turn === 1) { await seed(s, teamOf(employee('working'))); return { ...done('김대리한테 맡겼어요.', 1), trail: [{ tool: 'assign', args: {}, observation: '김대리한테 맡겼어요.' }] } }
    if (extra?.report) return done('김대리 보고: 11월 20일 서울 AI 서밋')
    return done(`답: ${request.message}`)
  })
  await s.chat('이거 김대리한테 맡겨: 다음 달 서울 IT 행사 일정 정리')
  expect(await first(s)).toMatchObject({ state: 'waiting', result: '김대리한테 맡겼어요.' })
  expect(s.delivered).toEqual(['김대리한테 맡겼어요.'])
  expect((await first(s)).question).toBeUndefined()
  // Nothing tells the person a task is paused, and no check turn ran on the ack.
  expect(s.notified).toEqual([])
  expect(s.sent).toHaveLength(1)
  // The thread's card reads this: no "작업이 멈췄어요" card and no attention mark while the employee works.
  expect(awaitingEmployees(await first(s))).toBe(true)
  // c1fix r1: 김대리 ends and hands over while the task still waits (team-runner logs it onto the task): still no card.
  await updateTask(s.paths, (await first(s)).id, t => { logTask(t, '김대리 handed over to 박사원') })
  expect(awaitingEmployees(await first(s))).toBe(true)
  // The person keeps chatting: a task of its own, and the waiting one is neither continued nor replaced.
  await s.chat('오늘 날씨 어때?')
  expect((await listTasks(s.paths)).map(t => t.state)).toEqual(['waiting', 'done'])
  expect(s.sent[1]!.extra?.context).toBeUndefined()
  // 김대리 ends: one report turn, quiet, with the report in the prompt, and no team check after it.
  await finishMember(s)
  await s.runner.report((await first(s)).id, 'bot-bot-1')
  expect(s.sent).toHaveLength(3)
  expect(s.sent[2]!.extra).toMatchObject({ quiet: true, report: true })
  expect(s.sent[2]!.extra?.verification).toBeUndefined()
  expect(s.sent[2]!.request.message).toContain('- 김대리 [done]: 11월 20일 서울 AI 서밋 https://example.com/summit')
  expect(await first(s)).toMatchObject({ state: 'done', result: '김대리 보고: 11월 20일 서울 AI 서밋' })
  expect(awaitingEmployees(await first(s))).toBe(false)
  expect(s.runner.activeChannels()).toEqual([])
})

it('a report that arrives while the person\'s turn is running waits for that turn to end', async () => {
  const order: string[] = []
  const s: World = await setup(async (_request, turn, extra, runner) => {
    if (turn === 1) { await seed(s, teamOf(employee('working'))); return done('김대리한테 맡겼어요.') }
    if (extra?.report) { order.push('report'); return done('김대리 보고') }
    // Mid-turn: 김대리 finishes and the runner is told.
    await finishMember(s)
    await runner.report((await first(s)).id, 'bot-bot-1')
    order.push('person turn ends')
    return done('답')
  })
  await s.chat('김대리한테 맡겨: 행사 일정')
  await s.chat('오늘 날씨 어때?')
  await vi.waitFor(async () => expect((await first(s)).state).toBe('done'))
  expect(order).toEqual(['person turn ends', 'report'])
  expect(s.sent.map(one => !!one.extra?.report)).toEqual([false, false, true])
})

it('an employee that ends before the ack turn does still gets its report', async () => {
  const s: World = await setup(async (_request, turn, extra, runner) => {
    if (extra?.report) return done('김대리 보고')
    if (turn === 1) { await seed(s, teamOf(employee('done', { result: '빠른 결과' }))); await runner.report((await first(s)).id, 'bot-bot-1') }
    return done('김대리한테 맡겼어요.')
  })
  await s.chat('김대리한테 맡겨: 행사 일정')
  await vi.waitFor(async () => expect((await first(s)).state).toBe('done'))
  expect(s.sent.map(one => !!one.extra?.report)).toEqual([false, true])
  expect((await first(s)).result).toBe('김대리 보고')
})

it('a stop ends the waiting task and a late report does nothing', async () => {
  const s: World = await setup(async (_request, turn) => { if (turn === 1) await seed(s, teamOf(employee('working'))); return done('김대리한테 맡겼어요.') })
  await s.chat('김대리한테 맡겨: 행사 일정')
  await s.runner.stopChannel('bot-bot-1')
  expect((await first(s)).state).toBe('stopped')
  await s.runner.report((await first(s)).id, 'bot-bot-1')
  expect(s.sent).toHaveLength(1)
  expect((await first(s)).state).toBe('stopped')
  expect(s.runner.activeChannels()).toEqual([])
})

// as-e1cf9bfd C5/C6: the thread showed "작업이 멈췄어요 / Waiting for the employees' report" while 김대리 was still working.
it('only a task waiting on its employees is cardless: a question, an open approval or any other pause still shows', () => {
  const parked = { state: 'waiting', approvals: [], awaitingEmployees: true }
  expect(awaitingEmployees(parked)).toBe(true)
  expect(awaitingEmployees({ ...parked, question: '어느 달 일정인가요?' })).toBe(false)
  expect(awaitingEmployees({ ...parked, approvals: [{}] })).toBe(false)
  expect(awaitingEmployees({ ...parked, approvals: [{ answer: 'approve' }] })).toBe(true)
  expect(awaitingEmployees({ state: 'waiting', approvals: [] })).toBe(false)
  expect(awaitingEmployees({ ...parked, state: 'failed' })).toBe(false)
})
