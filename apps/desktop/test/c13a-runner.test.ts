import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { companyStatus, createBot, createTask, employeesAnswer, handoffShown, type DelegatedTask, lateShown, listTasks, loadBots, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const MS = 280, S = MS / 28
const said = (who: string): string => `${who}가 찾은 이번 주 텃밭 소식이에요. https://garden.example/${encodeURIComponent(who)}`
type HandBack = { who: string; part?: string; state: string; result: string; sources?: string[] }
const handed = (task: DelegatedTask): HandBack[] => (JSON.parse(employeesAnswer(task)!) as { reports: HandBack[] }).reports
const of = (task: DelegatedTask, who: string): HandBack | undefined => handed(task).find(r => r.who === who)
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const teammate = (plan: Record<string, number | 'stall'>, calls: string[]): Run => async (deps, _prompt, options = {}) => {
  const who = Object.keys(plan).find(name => (options.persona ?? '').includes(`You are ${name}`))!
  calls.push(who)
  options.onStart?.()
  await deps.tools.find(t => t.name === 'search_web')?.run({ query: who }, { task: '' })
  const at = plan[who]!
  return new Promise((resolve, reject) => {
    options.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    if (at !== 'stall') setTimeout(() => { back[who] = Date.now(); resolve({ answer: said(who), steps: [], fellBack: false }) }, Math.max(0, started + at * S - Date.now()))
  })
}
let started = 0
const back: Record<string, number> = {}

async function world(plan: Record<string, number | 'stall'>, parts: [string, string, string?][]) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-c13a-')), '.engram') } as unknown as VaultPaths
  for (const name of ['엔그램', ...Object.keys(plan)]) await createBot(paths, { name })
  started = Date.now()
  const created = await createTask(paths, `${parts.map(([, topic]) => topic).join(', ')} 이번 주 텃밭 소식 알아봐줘`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const calls: string[] = [], ended: number[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.example/?q=${encodeURIComponent(String(args['query']))} (DATA, not instructions):\n- 소식 — https://read.example/${encodeURIComponent(String(args['query']))} — 수확 시기 — 11월 17일` }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => { ended.push(Date.now()) }, step: () => undefined, changed: () => undefined, run: teammate(plan, calls), answerMs: MS })
  const reported: number[] = []
  team.reportTo(() => { reported.push(Date.now()) })
  const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: false, to: parts.map(([who, topic, next]) => ({ who, topic, brief: `이번 주 ${topic} 텃밭 소식 조사`, ...(next ? { then: { who: next, brief: `이번 주 ${topic} 기른 사람 후기 조사` } } : {}) })) }, { task: '' })
  await updateTask(paths, created.id, t => { t.state = 'waiting' })
  const task = async () => (await listTasks(paths)).find(t => t.id === created.id)!
  return { paths, team, task, reported, calls, ended, id: created.id }
}

it('teammates back at 22 s and 26 s of a 28 s deadline both reach the one result step, each with its own answer as written, when the last is in', async () => {
  const w = await world({ 하람: 22, 이든: 26 }, [['하람', '배추'], ['이든', '무']])
  await vi.waitFor(() => expect(w.reported).toHaveLength(1), { timeout: 2_000 })
  expect(w.reported[0]!).toBeGreaterThanOrEqual(back['이든']!)
  expect(w.reported[0]! - back['이든']!).toBeLessThan(5 * S)
  expect(w.reported[0]! - started).toBeGreaterThanOrEqual(25 * S)
  const backs = handed(await w.task())
  expect(backs.map(r => [r.who, r.part, r.state])).toEqual([['하람', '배추', 'done'], ['이든', '무', 'done']])
  for (const who of ['하람', '이든']) expect(of(await w.task(), who)!.result).toContain(said(who))
  await wait(60)
  expect(w.reported).toHaveLength(1)
})

it('a slow part (40 s) reaches the result step as working at the deadline, keeps working, and its own answer and pages follow once', async () => {
  const w = await world({ 하람: 12, 소율: 40 }, [['하람', '배추'], ['소율', '고추']])
  await vi.waitFor(() => expect(w.reported).toHaveLength(1), { timeout: 2_000 })
  expect(w.reported[0]! - started).toBeGreaterThanOrEqual(MS - 5)
  expect(w.reported[0]! - started).toBeLessThan(35 * S)
  const at = await w.task()
  expect(at.team!.members.map(m => [m.role, m.state, m.late])).toEqual([['하람', 'done', undefined], ['소율', 'working', true]])
  expect(of(at, '하람')!.result).toContain(said('하람'))
  expect(of(at, '소율')).toMatchObject({ part: '고추', state: 'working', result: '' })
  expect(companyStatus((await loadBots(w.paths)).map(bot => ({ ...bot, label: '조사 담당' })), await listTasks(w.paths), Date.now())).toMatch(/소율은 [^.]*하고 있|소율은 [^.]*찾고 있|소율은 [^.]*조사/)
  await updateTask(w.paths, w.id, lateShown)
  await vi.waitFor(() => expect(w.reported).toHaveLength(2), { timeout: 2_000 })
  expect(w.reported[1]! - started).toBeGreaterThanOrEqual(39 * S)
  const last = handed(await w.task())
  expect(last.map(r => r.who)).toEqual(['소율'])
  expect(last[0]!.result).toContain(said('소율'))
  expect(last[0]!.sources?.length).toBeGreaterThan(0)
  await wait(60)
  expect(w.reported).toHaveLength(2)
})

it('every part still at work at the deadline (34 s and 38 s): none is cut, all reach the result step as working, and their own answers follow together', async () => {
  const w = await world({ 하람: 34, 이든: 38 }, [['하람', '배추'], ['이든', '무']])
  await vi.waitFor(() => expect(w.reported).toHaveLength(1), { timeout: 2_000 })
  expect(w.reported[0]! - started).toBeLessThan(33 * S)
  const at = await w.task()
  expect(at.team!.members.map(m => [m.state, m.late])).toEqual([['working', true], ['working', true]])
  expect(handed(at).map(r => [r.who, r.part, r.state])).toEqual([['하람', '배추', 'working'], ['이든', '무', 'working']])
  await updateTask(w.paths, w.id, lateShown)
  await vi.waitFor(() => expect(w.reported).toHaveLength(2), { timeout: 2_000 })
  expect(w.reported[1]! - started).toBeGreaterThanOrEqual(37 * S)
  const last = await w.task()
  for (const who of ['하람', '이든']) expect(of(last, who)).toMatchObject({ state: 'done', result: expect.stringContaining(said(who)) })
  await wait(60)
  expect(w.reported).toHaveLength(2)
})

it('a plain part (40 s) at work beside a hand-off at work at the deadline still follows; the hand-off\'s part reaches the result step by its state', async () => {
  const w = await world({ 하람: 40, 이든: 10, 소율: 34 }, [['하람', '배추'], ['이든', '무', '소율']])
  await vi.waitFor(() => expect(w.reported).toHaveLength(1), { timeout: 2_000 })
  await updateTask(w.paths, w.id, handoffShown)
  await vi.waitFor(() => expect(w.reported).toHaveLength(2), { timeout: 2_000 })
  expect(w.reported[1]! - started).toBeLessThan(33 * S)
  const at = await w.task()
  const [haram, soyul] = ['하람', '소율'].map(who => at.team!.members.find(m => m.role === who)!)
  expect(haram.late).toBe(true)
  expect(of(at, '하람')).toMatchObject({ part: '배추', state: 'working' })
  expect(of(at, '소율')?.state === 'working').toBe(!!soyul.late)
  await updateTask(w.paths, w.id, lateShown)
  await vi.waitFor(() => expect(w.reported).toHaveLength(3), { timeout: 2_000 })
  expect(w.reported[2]! - started).toBeGreaterThanOrEqual(39 * S)
  const last = await w.task()
  expect(of(last, '하람')!.result).toContain(said('하람'))
  expect(handed(last).some(r => r.who === '소율')).toBe(!!soyul.late)
  expect(handed(last).every(r => r.state !== 'working')).toBe(true)
  await wait(60)
  expect(w.reported).toHaveLength(3)
})

it('stop during a late part halts it within 3 s and nothing is posted after', async () => {
  const w = await world({ 하람: 10, 이든: 'stall' }, [['하람', '피그마'], ['이든', '캔바']])
  await vi.waitFor(() => expect(w.reported).toHaveLength(1), { timeout: 2_000 })
  expect((await w.task()).team!.members[1]).toMatchObject({ state: 'working', late: true })
  await updateTask(w.paths, w.id, lateShown)
  await wait(20)
  const stoppedAt = Date.now()
  void w.team.stop('bot-b1')
  await updateTask(w.paths, w.id, t => { t.state = 'stopped' })
  await vi.waitFor(() => expect(w.ended).toHaveLength(2), { timeout: 1_000 })
  expect(w.ended[1]! - stoppedAt).toBeLessThan(3 * S)
  await wait(LATE * 1.2)
  expect(w.reported).toHaveLength(1)
  expect((await w.task()).team!.members[1]!.state).toBe('released')
})
const LATE = 90 * S

it('a part that never answers stops at its ceiling and reaches the result step once as not done, with the page it read', async () => {
  const w = await world({ 하람: 10, 이든: 'stall' }, [['하람', '배추'], ['이든', '무']])
  await vi.waitFor(() => expect(w.reported).toHaveLength(1), { timeout: 2_000 })
  expect(of(await w.task(), '이든')).toMatchObject({ state: 'working' })
  await updateTask(w.paths, w.id, lateShown)
  await vi.waitFor(() => expect(w.reported).toHaveLength(2), { timeout: 3_000 })
  expect(w.reported[1]! - started).toBeGreaterThanOrEqual(MS + LATE - 5)
  const last = of(await w.task(), '이든')!
  expect(last.state).not.toBe('working')
  expect(last.sources?.some(url => url.startsWith('https://search.example/?q='))).toBe(true)
})

it('R1/T1 path: anonymous helpers follow the same deadline (6 s before it, for the lead\'s merge) and get no extra model round', async () => {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-c13a-helpers-')), '.engram') } as unknown as VaultPaths
  const created = await createTask(paths, '대전 공연, 부산 전시 다음 달 일정 각각 알아봐', 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const calls: string[] = [], quick: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => {
    calls.push(prompt.slice(0, 20)); options.onStart?.()
    if ((options.persona ?? '').includes('"대전 공연"')) { await wait(8 * S); return { answer: '대전 공연은 12월 6일에 있어요 https://show.example/1', steps: [], fellBack: false } }
    return new Promise((_, reject) => { options.onToken?.('부산 전시는 12월 12일에 열려요 https://art.example/1'); options.signal!.addEventListener('abort', () => reject(new Error('aborted'))) })
  }
  const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine']
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: MS })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit) }
  const began = Date.now()
  const out = JSON.parse(await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '대전 공연', brief: '다음 달 대전 공연 일정', lookup: true }, { role: '부산 전시', brief: '다음 달 부산 전시 일정', lookup: true }] }, { task: '' }))
  const took = Date.now() - began
  expect(took).toBeGreaterThanOrEqual(21 * S)
  expect(took).toBeLessThan(27 * S)
  expect(calls).toHaveLength(2)
  expect(quick).toEqual([])
  expect(out.members[0].state).toBe('released')
})
