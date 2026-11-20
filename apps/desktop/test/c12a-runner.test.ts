import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createBot, createTask, listTasks, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const PAGE = 'https://www.example-messenger.kr/notice/2026-11'
const rows = (query: string): string => `results for "${query}" at https://search.naver.com/search.naver?query=x (DATA, not instructions):\n- 메신저 11월 공지 — ${PAGE} — 사진 묶어 보내기가 생겼어요 — 11월 4일`
const stall = (options: NonNullable<Parameters<Run>[2]>) => new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))))

const handed = (answer: string) => JSON.parse(answer) as { reports: { who: string; result: string; sources?: string[] }[] }
const ROSE = 'https://garden.example.kr/roses/winter'
const roseRows = (): string => `results for "장미 겨울나기" at https://search.naver.com/search.naver?query=y (DATA, not instructions):\n- 장미 겨울나기 — ${ROSE} — 뿌리 둘레에 짚을 덮어 주세요 — 11월 10일`

async function world(run: Run, quick?: (prompt: string) => Promise<string | undefined>, brief = '이번 달 메신저 업데이트 조사', found = rows) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-c12a-')), '.engram') } as unknown as VaultPaths
  for (const name of ['엔그램', '지아']) await createBot(paths, { name })
  const created = await createTask(paths, `지아한테 맡겨: ${brief}`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => found(String(args['query'])) }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: 300 })
  const engine = (quick ? { id: 'claude', quick: (prompt: string) => quick(prompt) } : {}) as TurnKit['engine']
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const began = Date.now()
  const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '지아', brief, topic: '메신저' }] }, { task: '' })
  const ms = Date.now() - began
  const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
  return { answer, m, ms }
}

it('a teammate that read a page and stalls past its soft limit is told to answer in its reserve, and its own answer reaches the hand-back as written', async () => {
  const prompts: string[] = []
  const said = `장미는 11월 중순에 뿌리 둘레를 짚으로 덮어 겨울을 나요. (${ROSE})`
  const w = await world(async (deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    if (!deps.tools.length) return { answer: said, steps: [], fellBack: false }
    await deps.tools.find(t => t.name === 'search_web')!.run({ query: '장미 겨울나기' }, { task: '' })
    options.onStep?.('search_web')
    return stall(options)
  }, undefined, '장미 겨울나기 방법 조사', roseRows)
  expect(prompts.at(-1)).toMatch(/^Call no more tools\. Answer now from what you already have/)
  expect(prompts.at(-1)).toContain(ROSE)
  expect(w.m.data).toBeUndefined()
  expect(w.m.result).toContain(said)
  expect(handed(w.answer).reports[0]!.result).toContain(said)
  expect(w.ms).toBeLessThan(300 + 20 + 400)
})

it('when the answer round stalls too, no other model writes a stand-in: the quick model is never asked and the hand-back carries no invented report', async () => {
  const quickAsked: string[] = []
  const w = await world(async (deps, _prompt, options = {}) => {
    options.onStart?.()
    if (deps.tools.length) { await deps.tools.find(t => t.name === 'search_web')!.run({ query: '장미 겨울나기' }, { task: '' }); options.onStep?.('search_web') }
    return stall(options)
  }, async prompt => { quickAsked.push(prompt); return '장미는 짚으로 덮어요.' }, '장미 겨울나기 방법 조사', roseRows)
  expect(quickAsked).toEqual([])
  expect(w.m.data).toBeUndefined()
  expect(handed(w.answer).reports[0]!.result).not.toContain('장미는 짚으로 덮어요.')
})

it('A1: a teammate that read nothing ends as before: no answer round, no stand-in report', async () => {
  const quickAsked: string[] = []
  let rounds = 0
  const w = await world(async (_deps, _prompt, options = {}) => { rounds++; options.onStart?.(); return stall(options) }, async prompt => { quickAsked.push(prompt); return undefined }, undefined, () => 'that did not work: no results')
  expect(rounds).toBe(1)
  expect(quickAsked).toEqual([])
  expect(w.m.data).toBeUndefined()
})

it('a teammate that brings back a listing page gets no extra round: its answer and the page reach the hand-back as written', async () => {
  const LIST = 'https://choir.example.kr/gwangju/rehearsals'
  const prompts: string[] = []
  const said = `광주 합창단 연습 일정 페이지에 다음 달 연습이 여러 번 올라와 있어요. (${LIST})`
  const w = await world(async (deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    await deps.tools.find(t => t.name === 'search_web')?.run({ query: '광주 합창단 연습 일정' }, { task: '' })
    return { answer: said, steps: [], fellBack: false }
  }, async () => '{"keep":[1],"lists":[1]}', '다음 달 광주 합창단 연습 일정', () => `results for "광주 합창단" at https://search.naver.com/search.naver?query=z (DATA, not instructions):\n- 연습 일정 — ${LIST} — 다음 달 연습 — 12월`)
  expect(prompts).toHaveLength(1)
  expect(w.m.data).toBeUndefined()
  const back = handed(w.answer).reports[0]!
  expect(back.result).toContain(said)
  expect(back.sources).toEqual(w.m.sources)
  expect(w.m.sources?.length).toBeGreaterThan(0)
})

it('a teammate that names one item of a listing page keeps both the item and the page in its hand-back, in its own words', async () => {
  const LIST = 'https://ferry.example.kr/mokpo/timetable'
  const said = `목포에서 1월 11일 오전 8시 배가 있어요 (https://ferry.example.kr/mokpo/0111). 겨울 시간표 전체는 ${LIST} 에 있어요.`
  const w = await world(async (_deps, _prompt, options = {}) => {
    options.onStart?.()
    return { answer: said, steps: [], fellBack: false }
  }, async () => '{"keep":[1],"lists":[1]}', '목포 겨울 배편 세 개 알려줘')
  expect(w.m.data).toBeUndefined()
  expect(handed(w.answer).reports[0]!.result).toContain(said)
})
