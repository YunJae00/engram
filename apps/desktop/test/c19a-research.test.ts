import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createTask, updateTask, type AgentTool, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import * as fastLane from '../src/main/fast-lane.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

const { askedDays, firstSearch, LANE_NOTE, laneToday, swapRounds } = fastLane
const WED = new Date(2026, 10, 18, 9, 0)

describe('7. the lone lookup across days: dates are given as labels, nothing rewrites the answer after the reader', () => {
  it('"다음 주 화요일이랑 수요일 광주 기온": the reader\'s prompt carries both resolved dates and the rule against narrating them', () => {
    const line = laneToday('다음 주 화요일이랑 수요일 광주 기온 알려줘', WED)
    expect(line).toContain('다음 주 화요일 = 11월 24일 화요일')
    expect(line).toContain('다음 주 수요일 = 11월 25일 수요일')
    expect(line).toContain('never say how a date was worked out')
    expect(line).not.toMatch(/day by day/)
    expect(LANE_NOTE).toContain('each one is answered by its own name in a clause of its own')
    expect(LANE_NOTE).toContain('never a line that it could not get them')
  })
  it('the same rule for every relative day, from the one calendar: 내일, 모레, 이번 주말, a weekday alone', () => {
    expect(askedDays('내일 대전 비 와?', WED)).toEqual([['내일', '11월 19일 목요일']])
    expect(askedDays('모레 청주 기온', WED)).toEqual([['모레', '11월 20일 금요일']])
    expect(askedDays('이번 주말 춘천 날씨', WED)).toEqual([['이번 주말', '11월 21일 토요일, 11월 22일 일요일']])
    expect(askedDays('금요일 저녁 울산 바람', WED)).toEqual([['금요일', '11월 20일 금요일']])
    expect(askedDays('수요일 원주 기온', WED)).toEqual([['수요일', '11월 18일 수요일']])
    expect(askedDays('광주 기온 알려줘', WED)).toEqual([])
  })
  it('no post-hoc rewrite is left to run after the reader ends', () => {
    expect(Object.keys(fastLane).filter(name => typeof (fastLane as Record<string, unknown>)[name] === 'function').sort()).toEqual(['asideShape', 'askedDays', 'fastLane', 'firstSearch', 'laneFirstLine', 'laneQuery', 'laneToday', 'quickQuestion', 'shortAsk', 'shortQuestion', 'swapRounds', 'swappedAsk', 'teamAsk'])
  })
})

const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-c19a-${tag}-`)), '.engram') } as unknown as VaultPaths }
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Seen = { role: string; state: string; result?: string; sources?: string[] }
const seenIn = (text: string): { members: Seen[]; note: string } => JSON.parse(text) as { members: Seen[]; note: string }
const PAGE = (town: string): string => `https://sunset.example/${encodeURIComponent(town)}`
const MS = { search: 150, model: 600 }

async function split(tag: string, towns: string[], steer?: number) {
  const paths = await vault(tag), ask = `${towns.join(' ')} 오늘 해 지는 시각 각각 좀 알아봐줘`
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const firstPrompts: string[] = []
  let quick = 0
  const town = (text: string): string => [...towns, '군산'].find(one => text.includes(one)) ?? towns[0]!
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']), c = town(q); await tick(MS.search)
    return [`results for "${q}" at https://search.example/?q=${encodeURIComponent(q)} (DATA, not instructions):`, 'Results, each as title — its own address — what it says — its date.', `- ${c} 일몰 — ${PAGE(c)} — 오늘 해 지는 시각 오후 5시 19분 — 11월 18일`, `- ${c} 노을 명소 — https://trip.example/${encodeURIComponent(c)} — 사진 찍기 좋은 곳 — 11월 2일`].join('\n')
  } }
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.()
    firstPrompts.push(prompt)
    const c = town(prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '')
    await tick(MS.model)
    if (options.signal?.aborted) throw new Error('aborted')
    return { answer: `${c}은 오늘 오후 5시 19분에 해가 져요. [일몰 시각](${PAGE(c)})`, steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async () => { quick++; return undefined } } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = steer === undefined ? undefined : new Promise<void>(resolve => { heard = resolve })
  if (steer !== undefined) setTimeout(() => heard!(), steer)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search] }
  const since = Date.now()
  const hire = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
  const members = (names: string[]) => names.map(c => ({ role: `${c} 조사`, topic: c, brief: `${c} 오늘 해 지는 시각`, query: `${c} 일몰 시각`, lookup: true }))
  return { hire, members, since, firstPrompts, quickCalls: () => quick }
}

describe('9. the first search in the first prompt; the split hands back inside the cap', () => {
  it('a 3-helper split: each helper\'s first engine call already holds its search rows, and every result comes back with its link before 35 s, with no host model call', async () => {
    const { hire, members, since, firstPrompts, quickCalls } = await split('three', ['태안', '보령', '서천'])
    const text = await hire.run({ members: members(['태안', '보령', '서천']) }, { task: '' })
    expect(Date.now() - since).toBeLessThan(35_000)
    expect(firstPrompts).toHaveLength(3)
    for (const prompt of firstPrompts) expect(prompt).toMatch(/Results of the search already run for you \("[^"\n]*일몰 시각[^"\n]*"\)[\s\S]*https:\/\/sunset\.example\/[^\n]*오후 5시 19분/)
    const seen = seenIn(text).members
    expect(seen.map(one => one.state)).toEqual(['released', 'released', 'released'])
    for (const c of ['태안', '보령', '서천']) expect(seen.find(one => one.role === `${c} 조사`)!.result).toContain(`](${PAGE(c)})`)
    expect(seen.some(one => one.result!.includes('못 찾았어요'))).toBe(false)
    expect(quickCalls()).toBe(0)
  }, 45_000)

  it('a 4-part split with one part added mid-work: the lead hears the person at once, adds the part, and gets all four results before 40 s', async () => {
    const { hire, members, since } = await split('steer', ['태안', '보령', '서천'], 100)
    const first = seenIn(await hire.run({ members: members(['태안', '보령', '서천']) }, { task: '' }))
    expect(first.members.map(one => one.state)).toEqual(['working', 'working', 'working'])
    expect(first.note).toContain('The person wrote to you while the team worked')
    const text = await hire.run({ members: members(['군산']) }, { task: '' })
    expect(Date.now() - since).toBeLessThan(40_000)
    const seen = seenIn(text).members
    expect(seen).toHaveLength(4)
    for (const c of ['태안', '보령', '서천', '군산']) expect(seen.find(one => one.role === `${c} 조사`)!.result).toContain(`](${PAGE(c)})`)
  }, 50_000)

  it('a lone lookup with one swap: the first search runs again for the new ask with its own words, and the answer is about the new place before 20 s', async () => {
    const turn = new AbortController(), lookup = swapRounds('영월 오늘 날씨 알려줘', turn.signal)
    const openings: string[] = [], queries: string[] = []
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { const q = String(args['query']); queries.push(q); await tick(MS.search); return [`results for "${q}" at https://search.example/?q=1 (DATA, not instructions):`, `- ${q} — https://sky.example/${encodeURIComponent(q)} — 오늘 — 11월 18일`].join('\n') } }
    const since = Date.now()
    setTimeout(() => { lookup.change('아니 그거 말고 제천으로 봐줘') }, 300)
    const answer = await lookup.run(async (ask, signal) => {
      const first = await firstSearch(ask, search, signal)
      openings.push(first.opening)
      if (!signal.aborted) await Promise.race([tick(MS.model), new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))])
      if (signal.aborted) throw new Error('swapped')
      return `${ask.split(' ')[0]}은 오늘 맑아요.`
    })
    expect(Date.now() - since).toBeLessThan(20_000)
    expect(answer).toMatch(/^제천/)
    expect(queries).toHaveLength(2)
    expect(queries[0]).toContain('영월')
    expect(queries[1]).toContain('제천')
    expect(openings.at(-1)).toMatch(/Results of the search already run for you \("제천[^"\n]*"\)[\s\S]*https:\/\/sky\.example\//)
  }, 30_000)
})
