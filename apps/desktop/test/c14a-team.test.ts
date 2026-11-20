import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createBot, createTask, listTasks, updateTask, type AgentTool, type VaultPaths } from 'core'
import { emptyRetryNote, teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { asides, turnGoals } from '../src/main/turn-state.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = async (tag: string): Promise<VaultPaths> => {
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  return { cache: join(await mkdtemp(join(root, `engram-c14a-${tag}-`)), '.engram') } as unknown as VaultPaths
}
afterEach(() => { turnGoals.delete('bot-b1'); asides.delete('bot-b1') })

async function oneTeammate(tag: string, brief: string, answer: string, page: string) {
  const paths = await temporary(tag)
  for (const name of ['엔그램', '다온']) await createBot(paths, { name })
  const created = await createTask(paths, `다온한테 맡겨: ${brief}`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const prompts: string[] = [], judged: string[] = []
  const run: Run = async (deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    await deps.tools.find(t => t.name === 'search_web')?.run({ query: brief }, { task: '' })
    return { answer, steps: [], fellBack: false }
  }
  const quick = async (prompt: string): Promise<string | undefined> => { judged.push(prompt); return '{"keep":[1],"same":[[1,2]],"lists":[1]}' }
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.example/?q=x (DATA, not instructions):\n- ${brief} — ${page} — 일정 — 2026` }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: 600 })
  const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const out = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '다온', brief, topic: brief }] }, { task: '' })
  const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
  const back = (JSON.parse(out) as { reports: { who: string; result: string; sources?: string[] }[] }).reports[0]!
  return { prompts, judged, m, back }
}

it('a schedule teammate whose entries lack their day gets no host by-name round: its answer reaches the hand-back as written', async () => {
  const PAGE = 'https://library.example.kr/suwon/readings'
  const said = `수원 도서관 낭독회가 12월에 몇 번 열려요. 날짜는 목록 페이지에 있어요. (${PAGE})`
  const w = await oneTeammate('days', '다음 달 수원 도서관 낭독회 일정', said, PAGE)
  expect(w.prompts).toHaveLength(1)
  expect(w.judged).toEqual([])
  expect(w.m.data).toBeUndefined()
  expect(w.back.result).toContain(said)
  expect(w.back.sources).toEqual(w.m.sources)
})

it('a teammate whose answer gives one of two entries with its day hands back exactly that, with no extra round to fill the other', async () => {
  const PAGE = 'https://library.example.kr/ansan/list'
  const said = `안산 도서관 그림책 전시는 12월 5일에 시작해요 (https://library.example.kr/ansan/picture). 다른 전시 하나는 날짜가 아직 안 나왔어요 (${PAGE}).`
  const w = await oneTeammate('partial', '다음 달 안산 도서관 전시 일정', said, PAGE)
  expect(w.prompts).toHaveLength(1)
  expect(w.prompts.some(p => p.startsWith('Some of what you brought back'))).toBe(false)
  expect(w.back.result).toContain(said)
})

it.each([['a season page apart from the list', 'https://hall.example.kr/cheongju/season/2026-winter'], ['the list page itself', 'https://hall.example.kr/cheongju/season']])('two different entries that cite one same page both reach the hand-back as written; nothing merges them (%s)', async (_label, SEASON) => {
  const said = `청주 합창 송년 음악회는 12월 27일에 열려요 (${SEASON}). 청주 어린이 합창 발표회는 1월 17일이에요 (${SEASON}).`
  const w = await oneTeammate('shared', '이번 겨울 청주 합창 공연 일정', said, 'https://hall.example.kr/cheongju/season')
  expect(w.judged).toEqual([])
  expect(w.back.result).toContain('12월 27일')
  expect(w.back.result).toContain('1월 17일')
  expect(w.back.result).toContain(said)
})

function helperWorld(tag: string, run: Run) {
  return (async () => {
    const paths = await temporary(tag)
    const goal = '대전, 울산 오늘 날씨 알려줘'
    const created = await createTask(paths, goal, 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    turnGoals.set('bot-b1', goal)
    asides.set('bot-b1', [{ role: 'user', text: '광주도 넣어' }, { role: 'assistant', text: '광주도 볼게요.' }])
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.example/?q=${encodeURIComponent(String(args['query']))} (DATA, not instructions):\n- 검색 결과 없음 안내 — https://search.example/none — 일치하는 결과가 없어요 — 11월 18일` }
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine: {} as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => goal, nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
    const hire = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
    const member = async () => (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
    return { team, hire, member }
  })()
}

it('E class: a part that found nothing runs once more from the person\'s own line, not from its garbled words, on the same deadline', async () => {
  const prompts: string[] = []
  const w = await helperWorld('retry', async (_deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    return prompt.includes('- 광주도 넣어') ? { answer: '광주는 오늘 맑고 낮 최고 14도예요. https://weather.example/gwangju', steps: [], fellBack: false } : { answer: '관련 정보를 찾지 못했어요.', steps: [], fellBack: false }
  })
  const out = JSON.parse(await w.hire.run({ members: [{ role: '광주날씨', brief: '광즈 오늘 날씨', lookup: true, query: '광즈 날씨' }] }, { task: '' })) as { members: { result: string }[] }
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('Your part came back with nothing.')
  expect(prompts[1]).toContain('- 대전, 울산 오늘 날씨 알려줘\n- 광주도 넣어')
  expect(prompts[1]).not.toContain('광주도 볼게요')
  expect(out.members[0]!.result).toContain('https://weather.example/gwangju')
  expect(await w.member()).not.toHaveProperty('empty')
})

it('E class: one retry only; a part found empty again keeps where it looked', async () => {
  let runs = 0
  const w = await helperWorld('twice', async (_deps, _prompt, options = {}) => { runs++; options.onStart?.(); return { answer: '관련 정보를 찾지 못했어요.', steps: [], fellBack: false } })
  await w.hire.run({ members: [{ role: '광주날씨', brief: '광즈 오늘 날씨', lookup: true, query: '광즈 날씨' }] }, { task: '' })
  expect(runs).toBe(2)
  expect(await w.member()).toMatchObject({ empty: true })
  expect((await w.member()).sources).toEqual(['https://search.example/?q=%EA%B4%91%EC%A6%88%20%EB%82%A0%EC%94%A8'])
})

it('E class: a stop during the retry ends it at once, and no third run starts', async () => {
  let runs = 0
  let retrying!: () => void
  const second = new Promise<void>(resolve => { retrying = resolve })
  const w = await helperWorld('stop', async (_deps, _prompt, options = {}) => {
    runs++
    options.onStart?.()
    if (runs === 1) return { answer: '관련 정보를 찾지 못했어요.', steps: [], fellBack: false }
    retrying()
    return new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
  })
  const hired = w.hire.run({ members: [{ role: '광주날씨', brief: '광즈 오늘 날씨', lookup: true, query: '광즈 날씨' }] }, { task: '' }).catch(() => '')
  await second
  const at = Date.now()
  await w.team.stop('bot-b1')
  await hired
  expect(Date.now() - at).toBeLessThan(500)
  expect(runs).toBe(2)
  expect((await w.member()).state).toBe('released')
})

it('the retry brief is the person\'s lines and the other parts, with no host word list', () => {
  expect(emptyRetryNote(['서울 부산 날씨', '목포도'], ['서울', '부산'])).toBe('Your part came back with nothing. What the person said for this work, a line each:\n- 서울 부산 날씨\n- 목포도\nThe other parts: 서울, 부산.\nYour part is the piece of their words your brief is about. Search for it again in their words: the place, thing or name exactly as the person wrote it, not as your brief or your last search spelled it.')
})
