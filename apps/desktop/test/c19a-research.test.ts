import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkedSearch, createTask, helperAnswer, listTasks, mergingHire, setReportLog, updateTask, type AgentTool, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import * as fastLane from '../src/main/fast-lane.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

// c19a (cause H). Wordings and topics are in no harness row.
const { askedDays, LANE_NOTE, laneToday, swapRounds } = fastLane
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
    for (const gone of ['heldAnswer', 'weekendAnswer', 'heldFor', 'perDay', 'gaveUp']) expect(gone in fastLane).toBe(false)
  })
})

const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-c19a-${tag}-`)), '.engram') } as unknown as VaultPaths }
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
afterEach(() => { setReportLog(() => undefined) })
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const CHECK = 'Judge meaning only'
const PAGE = (city: string): string => `https://air.example/${encodeURIComponent(city)}`
// Realistic latencies (brief: search 1.5 s, page 1.3 s, a warm sonnet helper 6 s, the writer 4 s; the meaning check 2 s).
const MS = { search: 1500, page: 1300, model: 6000, write: 4000, check: 2000 }

async function split(tag: string, cities: string[], steer?: number) {
  const paths = await vault(tag), ask = `${cities.join(' ')} 오늘 미세먼지 각각 알아봐줘`
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const firstPrompts: string[] = [], quick: string[] = []
  const city = (text: string): string => [...cities, '포항'].find(one => text.includes(one)) ?? cities[0]!
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']), c = city(q); await tick(MS.search)
    return [`results for "${q}" at https://search.example/?q=${encodeURIComponent(q)} (DATA, not instructions):`, 'Results, each as title — its own address — what it says — its date.', `- ${c} 대기질 — ${PAGE(c)} — 오늘 대기 — 11월 18일`, `- ${c} 여행 블로그 — https://blog.example/${encodeURIComponent(c)} — 맛집 — 11월 2일`].join('\n')
  } }
  const open: AgentTool = { name: 'open_page', description: '', argsSchema: {}, run: async args => { const url = String(args['url']); await tick(MS.page); return `${url}\n${city(decodeURIComponent(url))} 오늘 미세먼지 보통(35㎍/㎥), 초미세먼지 좋음` } }
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.()
    firstPrompts.push(prompt)
    const c = city(prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '')
    await tick(MS.model)
    if (options.signal?.aborted) throw new Error('aborted')
    return { answer: `${c} 오늘 미세먼지는 보통(35㎍/㎥)이에요. [에어코리아](${PAGE(c)})`, steps: [], fellBack: false }
  }
  const write = async (prompt: string): Promise<string> => {
    if (prompt.includes(CHECK)) { quick.push('check'); await tick(MS.check); return JSON.stringify({ problems: [] }) }
    quick.push('write'); await tick(MS.write)
    const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { text: string; link: string }[] }[]
    const rows = data.filter(p => p.facts?.length)
    return JSON.stringify({ message: ['오늘 미세먼지는 모두 보통이에요.', '', '| 도시 | 미세먼지 | 출처 |', '|---|---|---|', ...rows.map(p => `| ${p.part} | ${p.facts![0]!.text} | ${p.facts![0]!.link} |`)].join('\n'), kept: [] })
  }
  const engine = { id: 'claude', quick: async (prompt: string) => write(prompt) } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = steer === undefined ? undefined : new Promise<void>(resolve => { heard = resolve })
  if (steer !== undefined) setTimeout(() => heard!(), steer)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search, open], alive: async () => true }
  const since = Date.now()
  const hire = mergingHire(team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!, async signal => helperAnswer({ ask, members: (await listTasks(paths)).find(t => t.state === 'running')?.team?.members, since, write, due: since + 28_000 + 4_000, ...(signal ? { signal } : {}) }))
  const members = (names: string[]) => names.map(c => ({ role: `${c} 조사`, topic: c, brief: `${c} 오늘 미세먼지`, query: `${c} 미세먼지`, lookup: true }))
  return { hire, members, since, firstPrompts, quick }
}

describe('9. pages in the first prompt; the split answers inside the cap', () => {
  it('a 3-helper split: each helper\'s first engine call already holds the opened page text, and one linked answer lands before 35 s', async () => {
    const { hire, members, since, firstPrompts } = await split('three', ['김해', '구미', '목포'])
    const text = await hire.run({ members: members(['김해', '구미', '목포']) }, { task: '' })
    const took = Date.now() - since
    console.log(`c19a 3-helper split: ${took} ms`)
    expect(took).toBeLessThan(35_000)
    expect(firstPrompts).toHaveLength(3)
    for (const prompt of firstPrompts) expect(prompt).toMatch(/The page at https:\/\/air\.example\/[^\n]*, opened and read[\s\S]*미세먼지 보통\(35㎍\/㎥\)/)
    for (const c of ['김해', '구미', '목포']) expect(text).toContain(`](${PAGE(c)})`)
    expect(text).not.toContain('못 찾았어요')
    expect(hire.closesOn!(text)).toBe(true)
  }, 45_000)

  it('a 4-part split with one part added mid-work: one answer with all four, before 40 s', async () => {
    const { hire, members, since } = await split('steer', ['김해', '구미', '목포'], 3000)
    const first = await hire.run({ members: members(['김해', '구미', '목포']) }, { task: '' })
    expect(hire.closesOn!(first)).toBe(false)
    const text = await hire.run({ members: members(['포항']) }, { task: '' })
    const took = Date.now() - since
    console.log(`c19a 4-part split with a mid-work addition: ${took} ms`)
    expect(took).toBeLessThan(40_000)
    for (const c of ['김해', '구미', '목포', '포항']) expect(text).toContain(`](${PAGE(c)})`)
    expect(hire.closesOn!(text)).toBe(true)
  }, 50_000)

  it('a lone lookup with one swap: the new ask\'s first search opens its pages too, and the reader answers before 20 s', async () => {
    const turn = new AbortController(), lookup = swapRounds('삼척 오늘 미세먼지 알려줘', turn.signal), steered: string[] = []
    const prompts: string[] = []
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { const q = String(args['query']); await tick(MS.search); return [`results for "${q}" at https://search.example/?q=1 (DATA, not instructions):`, `- ${q} 대기 — https://air.example/${encodeURIComponent(q)} — 오늘 — 11월 18일`].join('\n') } }
    const wrapped = checkedSearch(search, { ask: () => [lookup.ask(), ...steered].join('\n'), since: Date.now(), read: async url => { await tick(MS.page); return `${decodeURIComponent(url)} 미세먼지 좋음` } })
    const since = Date.now()
    setTimeout(() => { if (lookup.change('아 그냥 태백 걸로')) steered.push('아 그냥 태백 걸로') }, 2000)
    const answer = await lookup.run(async (ask, signal) => {
      const found = await wrapped.run({ query: ask.replace(/ 알려줘$/, '') }, { task: ask, signal })
      prompts.push(found)
      if (!signal.aborted) await Promise.race([tick(MS.model), new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))])
      if (signal.aborted) throw new Error('swapped')
      return `${ask.split(' ')[0]}은 오늘 미세먼지 좋음이에요.`
    })
    const took = Date.now() - since
    console.log(`c19a lone lookup with a swap: ${took} ms`)
    expect(took).toBeLessThan(20_000)
    expect(answer).toMatch(/^태백/)
    expect(prompts.at(-1)).toMatch(/The page at https:\/\/air\.example\/[^\n]*, opened and read[^\n]*\n[^\n]*태백/)
  }, 30_000)
})
