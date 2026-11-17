import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createBot, createTask, listTasks, updateTask, type AgentTool, type VaultPaths } from 'core'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

// c12a A1 (C3: two teammates read their release pages and were cut at the hard limit with nothing written) and B3 (a listing page taken
// apart in one more round). The limit is shortened through the existing seam: 300 ms stands for 15 s, so the 3 s answer reserve is 60 ms.
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const PAGE = 'https://www.example-messenger.kr/notice/2026-11'
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const rows = (query: string): string => `results for "${query}" at https://search.naver.com/search.naver?query=x (DATA, not instructions):\n- 메신저 11월 공지 — ${PAGE} — 사진 묶어 보내기가 생겼어요 — 11월 4일`
const stall = (options: NonNullable<Parameters<Run>[2]>) => new Promise<never>((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))))

async function world(run: Run, quick?: (prompt: string) => Promise<string | undefined>, brief = '이번 달 메신저 업데이트 조사', found = rows) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const paths = { cache: join(await mkdtemp(join(temporary, 'engram-c12a-')), '.engram') } as unknown as VaultPaths
  for (const name of ['엔그램', '지아']) await createBot(paths, { name })
  const created = await createTask(paths, `지아한테 맡겨: ${brief}`, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => found(String(args['query'])) }
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, lookupHardMs: 300 })
  const engine = (quick ? { id: 'claude', quick: (prompt: string) => quick(prompt) } : {}) as TurnKit['engine']
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => [...team.tools(lane, kit), search] }
  const began = Date.now()
  const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '지아', brief, topic: '메신저' }] }, { task: '' })
  const ms = Date.now() - began
  const m = (await listTasks(paths)).find(t => t.id === created.id)!.team!.members[0]!
  return { answer, m, ms }
}

it('A1: a teammate that read a page and stalls past its soft limit is told to answer in its reserve, and ends with that page\'s facts', async () => {
  const prompts: string[] = []
  const w = await world(async (deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    if (!deps.tools.length) return { answer: block({ facts: [{ text: '사진 묶어 보내기가 생겼어요.', url: PAGE, date: '11월 4일' }] }), steps: [], fellBack: false }
    await deps.tools.find(t => t.name === 'search_web')!.run({ query: '메신저 11월 업데이트' }, { task: '' })
    options.onStep?.('search_web')
    return stall(options)
  })
  // The answer round has no tools and is the tool path's own "answer now", with what it read.
  expect(prompts.at(-1)).toMatch(/^Call no more tools\. Answer now from what you already have/)
  expect(prompts.at(-1)).toContain(PAGE)
  expect(w.m.data?.facts.map(f => f.url)).toEqual([PAGE])
  expect(w.m.result).not.toBe('')
  expect(w.answer).toContain(`](${PAGE})`)
  // Inside the hard limit plus the grace: never longer than today's limit.
  expect(w.ms).toBeLessThan(300 + 20 + 400)
})

it('A1: when the answer round stalls too, the quick model writes the report from the kept rows under the same rule', async () => {
  const quickAsked: string[] = []
  const w = await world(async (deps, _prompt, options = {}) => {
    options.onStart?.()
    if (deps.tools.length) { await deps.tools.find(t => t.name === 'search_web')!.run({ query: '메신저 11월 업데이트' }, { task: '' }); options.onStep?.('search_web') }
    return stall(options)
  }, async prompt => { quickAsked.push(prompt); return prompt.includes('ran out of time') ? block({ facts: [{ text: '사진 묶어 보내기가 생겼어요.', url: PAGE, date: '11월 4일' }] }) : undefined })
  expect(quickAsked.find(p => p.includes('ran out of time'))).toContain(PAGE)
  expect(w.m.data?.facts.map(f => f.text)).toEqual(['사진 묶어 보내기가 생겼어요.'])
  expect(w.answer).toContain(`](${PAGE})`)
})

it('A1: a teammate that read nothing ends as before: no answer round, no stand-in report', async () => {
  const quickAsked: string[] = []
  let rounds = 0
  // The host's own first search comes back empty too, so nothing at all was read.
  const w = await world(async (_deps, _prompt, options = {}) => { rounds++; options.onStart?.(); return stall(options) }, async prompt => { quickAsked.push(prompt); return undefined }, undefined, () => 'that did not work: no results')
  expect(rounds).toBe(1)
  expect(quickAsked).toEqual([])
  expect(w.m.data).toBeUndefined()
})

it('B3: a listing page the item check flags is taken apart in one more round while the teammate has time; its items take the page\'s place', async () => {
  const LIST = 'https://board.example.kr/daejeon/schedule'
  const prompts: string[] = []
  const w = await world(async (deps, prompt, options = {}) => {
    prompts.push(prompt)
    options.onStart?.()
    if (prompt.startsWith('Some of what you brought back')) return { answer: block({ facts: [{ text: '12월 6일 둔산동에서 보드게임 모임이 열려요.', url: 'https://board.example.kr/daejeon/1206', date: '12월 6일' }, { text: '12월 20일 유성에서 보드게임 모임이 열려요.', url: 'https://board.example.kr/daejeon/1220', date: '12월 20일' }], whole: [LIST] }), steps: [], fellBack: false }
    expect(deps.tools.length).toBeGreaterThan(0)
    return { answer: block({ facts: [{ text: '대전 보드게임 카페 일정 페이지에 다음 달 모임이 여러 개 올라와 있어요.', url: LIST }] }), steps: [], fellBack: false }
  }, async prompt => prompt.includes('"lists"') ? '{"keep":[1],"lists":[1],"names":{"1":"보드게임 모임 일정"}}' : undefined, '다음 달 대전 보드게임 모임 일정')
  expect(prompts.at(-1)).toContain(LIST)
  expect(w.m.data?.facts.map(f => f.url)).toEqual(['https://board.example.kr/daejeon/1206', 'https://board.example.kr/daejeon/1220'])
  expect(w.answer.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2)
})

it('round 2: an extra round that gives only part of a listing page keeps the page, labeled, beside the item it did give', async () => {
  const LIST = 'https://climb.example.kr/incheon/meets'
  const w = await world(async (_deps, prompt, options = {}) => {
    options.onStart?.()
    if (prompt.startsWith('Some of what you brought back')) return { answer: block({ facts: [{ text: '1월 11일 송도 클라이밍장에서 모임이 있어요.', url: 'https://climb.example.kr/incheon/0111', date: '1월 11일' }] }), steps: [], fellBack: false }
    return { answer: block({ facts: [{ text: '인천 클라이밍 모임 페이지에 이번 겨울 모임 세 개가 있어요.', url: LIST }] }), steps: [], fellBack: false }
  }, async prompt => prompt.includes('"lists"') ? '{"keep":[1],"lists":[1]}' : undefined, '인천 클라이밍 모임 세 개 알려줘')
  expect(w.m.data?.facts.map(f => [f.url, f.listing])).toEqual([[LIST, true], ['https://climb.example.kr/incheon/0111', undefined]])
  expect(w.answer).toContain('하나씩은 아직 못 뽑았어요.')
})
