import { expect, it, vi } from 'vitest'
import { employeesAnswer, failOnRestart, lateShown, listTasks, logTask, markLate, updateTask, type TaskTeam, type TeamMember } from 'core'
import { done, setup } from './task-runner-fixture.js'
import { awaitingEmployees } from '../src/shared/task-waits.js'

const employee = (state: TeamMember['state'], more: Partial<TeamMember> = {}): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '행사 일정 정리', botId: 'kim', lookup: true, background: true, state, sessionKey: 'team-x-m1', hiredAt: new Date().toISOString(), ...more })
const teamOf = (...members: TeamMember[]): TaskTeam => ({ members, hires: members.length, maxHires: 8, maxDepth: 3, big: false })
type World = Awaited<ReturnType<typeof setup>>
const first = async (s: World) => (await listTasks(s.paths))[0]!
const seed = async (s: World, team: TaskTeam) => updateTask(s.paths, (await listTasks(s.paths)).at(-1)!.id, t => { t.team = team })
const finishMember = async (s: World) => updateTask(s.paths, (await first(s)).id, t => { Object.assign(t.team!.members[0]!, { state: 'done', result: '11월 20일 서울 AI 서밋 https://example.com/summit' }) })

it('a hand-off ends the turn on the ack, leaves the thread free, and the report comes back as one turn of its own', async () => {
  const s: World = await setup(async (request, turn, extra) => {
    if (turn === 1) { await seed(s, teamOf(employee('working'))); return { ...done('지민한테 맡겼어요.', 1), trail: [{ tool: 'assign', args: {}, observation: '지민한테 맡겼어요.' }] } }
    if (extra?.report) return done('지민 보고: 11월 20일 서울 AI 서밋')
    return done(`답: ${request.message}`)
  })
  await s.chat('이거 지민한테 맡겨: 다음 달 서울 IT 행사 일정 정리')
  expect(await first(s)).toMatchObject({ state: 'waiting', result: '지민한테 맡겼어요.' })
  expect(s.delivered).toEqual(['지민한테 맡겼어요.'])
  expect((await first(s)).question).toBeUndefined()
  expect(s.notified).toEqual([])
  expect(s.sent).toHaveLength(1)
  expect(awaitingEmployees(await first(s))).toBe(true)
  await updateTask(s.paths, (await first(s)).id, t => { logTask(t, '지민 handed over to 서연') })
  expect(awaitingEmployees(await first(s))).toBe(true)
  await s.chat('오늘 날씨 어때?')
  expect((await listTasks(s.paths)).map(t => t.state)).toEqual(['waiting', 'done'])
  expect(s.sent[1]!.extra?.context).toBeUndefined()
  await finishMember(s)
  await s.runner.report((await first(s)).id, 'bot-bot-1')
  expect(s.sent).toHaveLength(3)
  expect(s.sent[2]!.extra).toMatchObject({ quiet: true, report: true })
  expect(s.sent[2]!.extra?.verification).toBeUndefined()
  expect(s.sent[2]!.request.message).toContain('- 지민 [done]: 11월 20일 서울 AI 서밋 https://example.com/summit')
  expect(await first(s)).toMatchObject({ state: 'done', result: '지민 보고: 11월 20일 서울 AI 서밋' })
  expect(awaitingEmployees(await first(s))).toBe(false)
  expect(s.runner.activeChannels()).toEqual([])
})

it('a report that arrives while the person\'s turn is running waits for that turn to end', async () => {
  const order: string[] = []
  const s: World = await setup(async (_request, turn, extra, runner) => {
    if (turn === 1) { await seed(s, teamOf(employee('working'))); return done('지민한테 맡겼어요.') }
    if (extra?.report) { order.push('report'); return done('지민 보고') }
    await finishMember(s)
    await runner.report((await first(s)).id, 'bot-bot-1')
    order.push('person turn ends')
    return done('답')
  })
  await s.chat('지민한테 맡겨: 행사 일정')
  await s.chat('오늘 날씨 어때?')
  await vi.waitFor(async () => expect((await first(s)).state).toBe('done'))
  expect(order).toEqual(['person turn ends', 'report'])
  expect(s.sent.map(one => !!one.extra?.report)).toEqual([false, false, true])
})

it('an agent that ends before the ack turn does still gets its report', async () => {
  const s: World = await setup(async (_request, turn, extra, runner) => {
    if (extra?.report) return done('지민 보고')
    if (turn === 1) { await seed(s, teamOf(employee('done', { result: '빠른 결과' }))); await runner.report((await first(s)).id, 'bot-bot-1') }
    return done('지민한테 맡겼어요.')
  })
  await s.chat('지민한테 맡겨: 행사 일정')
  await vi.waitFor(async () => expect((await first(s)).state).toBe('done'))
  expect(s.sent.map(one => !!one.extra?.report)).toEqual([false, true])
  expect((await first(s)).result).toBe('지민 보고')
})

it('a stop ends the waiting task and a late report does nothing', async () => {
  const s: World = await setup(async (_request, turn) => { if (turn === 1) await seed(s, teamOf(employee('working'))); return done('지민한테 맡겼어요.') })
  await s.chat('지민한테 맡겨: 행사 일정')
  await s.runner.stopChannel('bot-bot-1')
  expect((await first(s)).state).toBe('stopped')
  await s.runner.report((await first(s)).id, 'bot-bot-1')
  expect(s.sent).toHaveLength(1)
  expect((await first(s)).state).toBe('stopped')
  expect(s.runner.activeChannels()).toEqual([])
})

it('only a task waiting on its agents is cardless: a question, an open approval or any other pause still shows', () => {
  const parked = { state: 'waiting', approvals: [], awaitingEmployees: true }
  expect(awaitingEmployees(parked)).toBe(true)
  expect(awaitingEmployees({ ...parked, question: '어느 달 일정인가요?' })).toBe(false)
  expect(awaitingEmployees({ ...parked, approvals: [{}] })).toBe(false)
  expect(awaitingEmployees({ ...parked, approvals: [{ answer: 'approve' }] })).toBe(true)
  expect(awaitingEmployees({ state: 'waiting', approvals: [] })).toBe(false)
  expect(awaitingEmployees({ ...parked, state: 'failed' })).toBe(false)
})

it('a part that ends while the report without it is being written still gets its own report, once', async () => {
  let reports = 0, id = '', race = true
  const s: World = await setup(async (_request, turn, extra, runner) => {
    if (turn === 1) { await seed(s, teamOf(employee('working'), employee('working', { id: 'm2', role: '서연', brief: '슬랙 조사', botId: 'seo', sessionKey: 'team-x-m2' }))); return done('지민, 서연한테 나눠 맡겼어요.') }
    if (!extra?.report) return done('답')
    await updateTask(s.paths, id, lateShown)
    if (!race) return done('보고')
    if (++reports === 1) await updateTask(s.paths, id, t => { Object.assign(t.team!.members[1]!, { state: 'done', result: '슬랙이 캔버스 공유를 냈어요 https://example.com/b' }) })
    else await runner.report(id, 'bot-bot-1')
    return done(reports === 1 ? '표: 서연은 아직 찾는 중이에요.' : '서연이 슬랙 조사해 왔어요.')
  })
  await s.chat('노션, 슬랙 조사해줘. 지민, 서연한테 나눠서 시켜')
  id = (await first(s)).id
  await finishMember(s)
  await updateTask(s.paths, id, markLate)
  expect((await first(s)).team!.members.map(m => m.late)).toEqual([undefined, true])
  await s.runner.report(id, 'bot-bot-1')
  await vi.waitFor(async () => expect(await first(s)).toMatchObject({ state: 'done', result: '서연이 슬랙 조사해 왔어요.' }))
  await vi.waitFor(() => expect(s.runner.activeChannels()).toEqual([]))
  expect(s.sent.map(one => !!one.extra?.report)).toEqual([false, true, true])
  expect((await first(s)).team).toMatchObject({ lateTold: true, lateDone: true })
  await s.chat('리니어, 지라 조사해줘. 지민, 서연한테 나눠서 시켜')
  const again = id = (await listTasks(s.paths)).at(-1)!.id
  race = false
  await seed(s, teamOf(employee('done', { result: '리니어 소식 https://example.com/c' }), employee('working', { id: 'm2', role: '서연', brief: '지라 조사', botId: 'seo', sessionKey: 'team-y-m2' })))
  await updateTask(s.paths, again, t => { t.state = 'waiting'; markLate(t) })
  await s.runner.report(again, 'bot-bot-1')
  expect((await listTasks(s.paths)).at(-1)).toMatchObject({ state: 'waiting', team: { lateTold: true } })
  expect((await listTasks(s.paths)).at(-1)!.team!.lateDone).toBeUndefined()
  await updateTask(s.paths, again, t => { Object.assign(t.team!.members[1]!, { state: 'done', result: '지라 소식 https://example.com/d' }) })
  await s.runner.report(again, 'bot-bot-1')
  await vi.waitFor(async () => expect((await listTasks(s.paths)).at(-1)).toMatchObject({ state: 'done', team: { lateDone: true } }))
  expect(s.sent.filter(one => one.extra?.report)).toHaveLength(4)
})

it('an owed late part survives a restart: its hand-back reaches one report step if it had ended, and as a failed part if it died with the app', async () => {
  const handed: string[] = []
  const lead = async (s: World, extra: { report?: true } | undefined, said: string) => {
    if (!extra?.report) return done('네, 알겠어요.')
    const task = (await listTasks(s.paths)).find(t => t.state === 'running')!
    handed.push(employeesAnswer(task) ?? '')
    await updateTask(s.paths, task.id, lateShown)
    return done(said)
  }
  for (const died of [false, true]) {
    const early = '민서가 보니 자전거 보관소는 지하 1층이에요. [관리실 안내](https://apt.example/bike)\n\n택배함은 우진이 아직 찾는 중이에요. 끝나면 이어서 올릴게요.'
    const late = died ? '택배함은 우진이 이번엔 못 찾았어요.' : '우진이 찾아보니 택배함은 정문 옆에 있어요. [단지 지도](https://apt.example/map)'
    const before: World = await setup(async (_request, turn, extra) => {
      if (turn === 1) { await seed(before, teamOf(employee('working', { role: '민서', brief: '자전거 보관소 위치', topic: '자전거 보관소' }), employee('working', { id: 'm2', role: '우진', brief: '택배함 위치', topic: '택배함', botId: 'woo', sessionKey: 'team-x-m2' }))); return done('민서, 우진한테 나눠 맡겼어요.') }
      return lead(before, extra, early)
    })
    await before.chat('자전거 보관소랑 택배함 위치 알아봐줘. 민서, 우진한테 나눠서 맡겨')
    const id = (await first(before)).id
    await updateTask(before.paths, id, t => { Object.assign(t.team!.members[0]!, { state: 'done', result: '자전거 보관소는 지하 1층이에요. https://apt.example/bike' }); markLate(t) })
    await before.runner.report(id, 'bot-bot-1')
    await vi.waitFor(async () => expect(await first(before)).toMatchObject({ state: 'waiting', result: early, team: { lateTold: true } }))
    expect(handed.at(-1)).toContain('"who":"민서"')
    expect(handed.at(-1)).toContain('자전거 보관소는 지하 1층이에요. https://apt.example/bike')
    expect((await first(before)).result).toBe(early)
    await updateTask(before.paths, id, t => { if (died) t.state = 'running'; else Object.assign(t.team!.members[1]!, { state: 'done', result: '택배함은 정문 옆에 있어요. https://apt.example/map' }) })
    const after: World = await setup(async (_request, _turn, extra) => lead(after, extra, late), true, undefined, undefined, before.paths)
    await after.runner.resume()
    expect(await first(after)).toMatchObject({ state: 'waiting', awaitingEmployees: true })
    expect((await first(after)).question).toBeUndefined()
    if (died) await updateTask(after.paths, id, t => { failOnRestart(t.team!, new Date().toISOString()) })
    await after.runner.report(id, 'bot-bot-1')
    await vi.waitFor(async () => expect(await first(after)).toMatchObject({ state: 'done', result: late, team: { lateDone: true } }))
    expect(handed.at(-1)).toContain('"who":"우진"')
    expect(handed.at(-1)).toContain(died ? 'Failed: the app restarted while this member was working.' : '택배함은 정문 옆에 있어요. https://apt.example/map')
    await after.runner.report(id, 'bot-bot-1')
    await vi.waitFor(() => expect(after.runner.activeChannels()).toEqual([]))
    expect(after.sent.filter(one => one.extra?.report)).toHaveLength(1)
    expect((await first(after)).result).toBe(late)
  }
})
