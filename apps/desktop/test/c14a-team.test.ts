import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createBot, createTask, listTasks, updateTask, type AgentTool, type VaultPaths } from 'core'
import { emptyRetryNote, teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { asides, turnGoals } from '../src/main/turn-state.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const temporary = async (tag: string): Promise<VaultPaths> => {
  const root = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(root, { recursive: true })
  return { cache: join(await mkdtemp(join(root, `engram-c14a-${tag}-`)), '.engram') } as unknown as VaultPaths
}
afterEach(() => { turnGoals.delete('bot-b1'); asides.delete('bot-b1') })

it('C5 class: a schedule teammate whose entries lack their day looks again, by each entry\'s name, before handing back', async () => {
  const paths = await temporary('days')
  for (const name of ['엔그램', '하윤']) await createBot(paths, { name })
  const brief = '다음 달 부산 디자인 전시 일정'
  const created = await createTask(paths, `하윤한테 맡겨: ${brief}`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const PAGE = 'https://design.example.kr/busan/2026', OWN = 'https://design.example.kr/busan/typo-week'
  const prompts: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    if (prompt.includes('Search each entry by its own name')) return { answer: block({ facts: [{ text: '부산 타이포 위크는 12월 9일 영화의전당에서 열려요.', url: OWN, date: '12월 9일' }] }), steps: [], fellBack: false }
    return { answer: block({ facts: [{ text: '부산 타이포 위크가 12월에 열려요.', url: PAGE }] }), steps: [], fellBack: false }
  }
  const quick = async (prompt: string): Promise<string | undefined> => !prompt.includes('"lists"') ? undefined : prompt.includes('12월 9일') ? '{"keep":[1],"lists":[]}' : '{"keep":[1],"lists":[1],"names":{"1":"부산 타이포 위크"}}'
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.example/?q=x (DATA, not instructions):\n- 부산 디자인 전시 — ${PAGE} — 12월 — 2026` }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: 600 })
  const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '하윤', brief, topic: '부산 디자인 전시' }] }, { task: '' })
  const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
  expect(prompts.filter(p => p.startsWith('Some of what you brought back'))).toHaveLength(2)
  expect(m.data?.facts.map(f => [f.url, f.listing ?? false, f.rest ?? false])).toEqual([[OWN, false, false], [PAGE, true, true]])
  expect(answer).toContain('12월 9일')
})

it('C5 class r2: a page whose first round gave one of its two entries still gets the by-name round, and both entries are in one answer', async () => {
  const paths = await temporary('partial')
  for (const name of ['엔그램', '하윤']) await createBot(paths, { name })
  const brief = '다음 달 부산 전시 일정'
  const created = await createTask(paths, `하윤한테 맡겨: ${brief}`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const PAGE = 'https://art.example.kr/busan/list', A = 'https://art.example.kr/busan/ceramic', B = 'https://art.example.kr/busan/light'
  const prompts: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    if (prompt.includes('Search each entry by its own name')) return { answer: block({ facts: [{ text: '부산 빛 예술전은 12월 20일 시작해요.', url: B, date: '12월 20일' }, { text: '도자 공예전 12월 5일 개막', url: A, date: '12월 5일' }] }), steps: [], fellBack: false }
    if (prompt.startsWith('Some of what you brought back')) return { answer: block({ facts: [{ text: '부산 도자 공예전은 12월 5일에 열려요.', url: A, date: '12월 5일' }] }), steps: [], fellBack: false }
    return { answer: block({ facts: [{ text: '부산에서 12월에 전시 두 건이 열려요.', url: PAGE }] }), steps: [], fellBack: false }
  }
  const quick = async (prompt: string): Promise<string | undefined> => !prompt.includes('"lists"') ? undefined : prompt.includes('개막') ? '{"keep":[1,2,3],"same":[[1,3]],"lists":[]}' : /\d+월 \d+일/.test(prompt) ? '{"keep":[1],"lists":[]}' : '{"keep":[1],"lists":[1],"names":{"1":"부산 전시"}}'
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.example/?q=x (DATA, not instructions):\n- 부산 전시 — ${PAGE} — 12월 — 2026` }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: 600 })
  const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '하윤', brief, topic: '부산 전시' }] }, { task: '' })
  const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
  const rounds = prompts.filter(p => p.startsWith('Some of what you brought back'))
  expect(rounds).toHaveLength(2)
  expect(rounds[1]).toContain('- 부산 도자 공예전은 12월 5일에 열려요.')
  expect(m.data?.facts.map(f => [f.url, f.rest ?? false])).toEqual([[A, false], [B, false], [PAGE, true]])
  expect(answer).toContain('12월 5일')
  expect(answer).toContain('12월 20일')
})

it.each([['a season page apart from the list', 'https://stage.example.kr/daegu/season/2026-winter'], ['the list page itself', 'https://stage.example.kr/daegu/season']])('C5 class r3: two different entries that cite one same schedule page are both kept; only the judge\'s "same" makes a re-find (%s)', async (_label, SEASON) => {
  const paths = await temporary('shared')
  for (const name of ['엔그램', '하윤']) await createBot(paths, { name })
  const brief = '이번 겨울 대구 공연 일정'
  const created = await createTask(paths, `하윤한테 맡겨: ${brief}`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const LIST = 'https://stage.example.kr/daegu/season'
  const prompts: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    if (prompt.includes('Search each entry by its own name')) return { answer: block({ facts: [{ text: '현악 사중주의 밤은 1월 17일 대구콘서트하우스에서 열려요.', url: SEASON, date: '1월 17일' }] }), steps: [], fellBack: false }
    if (prompt.startsWith('Some of what you brought back')) return { answer: block({ facts: [{ text: '겨울 오페라 갈라는 12월 27일 무대에 올라요.', url: SEASON, date: '12월 27일' }] }), steps: [], fellBack: false }
    return { answer: block({ facts: [{ text: '대구 겨울 시즌 공연 두 편이 있어요.', url: LIST }] }), steps: [], fellBack: false }
  }
  const judged: string[] = []
  const quick = async (prompt: string): Promise<string | undefined> => {
    if (!prompt.includes('"lists"')) return undefined
    judged.push(prompt)
    return prompt.includes('현악') ? '{"keep":[1,2],"same":[],"lists":[]}' : prompt.includes('12월 27일') ? '{"keep":[1],"lists":[]}' : '{"keep":[1],"lists":[1],"names":{"1":"대구 겨울 공연"}}'
  }
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => `results for "${String(args['query'])}" at https://search.example/?q=x (DATA, not instructions):\n- 대구 겨울 공연 — ${LIST} — 12월 — 2026` }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, answerMs: 600 })
  const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '하윤', brief, topic: '대구 공연' }] }, { task: '' })
  const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
  expect(judged.at(-1)).toMatch(/오페라 갈라[\s\S]*현악 사중주/)
  expect(m.data?.facts.map(f => [f.url, f.date ?? '', f.rest ?? false])).toEqual([[SEASON, '12월 27일', false], [SEASON, '1월 17일', false], [LIST, '', true]])
  expect(answer).toContain('12월 27일')
  expect(answer).toContain('1월 17일')
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
