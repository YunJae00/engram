import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkedSearch, createBot, createTask, LOOKUP_RESERVE_MS, mergedReport, REPORT_WRITER_MS, reportData, settleMember, TEAM_ANSWER_MS, updateTask, WIDEN_MS, writtenReport, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-stack14-${tag}-`)), '.engram') } as unknown as VaultPaths }
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const CHECK = 'Judge meaning only', REDO = 'You fix a message'
const none = JSON.stringify({ problems: [] })
const problem = (kind: string, quote: string): string => JSON.stringify({ problems: [{ kind, quote, why: '데이터와 달라요' }] })
const rows = (from: number, n: number): string => Array.from({ length: n }, (_, i) => `- 전주 한옥 카페 ${from + i}호점 개업 — https://news.example.kr/${from + i} — 11월 ${from + i}일`).join('\n')
afterEach(() => { vi.useRealTimers() })

describe('stack-14 merge: one clock', () => {
  it('slow search rounds end on the lookup deadline; a team answer whose check needs a rewrite still lands before 35 s', async () => {
    let t = 0
    const queries: string[] = []
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { t += 7_000; queries.push(String(args['query'])); return `results for "${String(args['query'])}" at https://search.example/?q=1 (DATA, not instructions):\n${rows(queries.length * 10, 2)}` } }
    let round = 0
    const write = async (): Promise<string> => { t += 2_500; round++; return JSON.stringify({ keep: [1], unsure: [], same: [], lists: [], names: {}, listing: [], outside: [], search: `전주 카페 개업 ${round}` }) }
    const tool = checkedSearch(search, { ask: () => '전주 한옥 카페 개업 소식 5개', write, since: 0, now: () => t })
    t = 7_000
    await tool.run({ query: '전주 한옥 카페 개업' }, { task: '' })
    const searchEnded = t
    expect(searchEnded).toBeLessThanOrEqual(TEAM_ANSWER_MS - LOOKUP_RESERVE_MS + WIDEN_MS)
    expect(new Set(queries).size).toBe(queries.length)

    const T0 = Date.parse('2026-11-18T03:00:00Z')
    vi.useFakeTimers({ now: T0 + TEAM_ANSWER_MS, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const part = (id: string, role: string, topic: string, text: string, url: string): TeamMember => {
      const m: TeamMember = { id, parentId: null, depth: 1, role, brief: `${topic} 오늘 바다 날씨`, topic, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: new Date(T0).toISOString() }
      const answer = block({ facts: [{ text, url }] })
      settleMember(m, { answer, report: reportData(answer, m, [], true) ?? null }, new Date(T0 + TEAM_ANSWER_MS).toISOString(), true)
      return m
    }
    const members = [part('m1', '하람', '강릉', '강릉 바다는 오늘 물결이 1미터로 잔잔해요.', 'https://sea.example.kr/gangneung'), part('m2', '이든', '속초', '속초 바다는 오늘 풍랑주의보가 있어요.', 'https://sea.example.kr/sokcho')]
    const body = '강릉은 하람이 봤는데 물결이 잔잔해요. [a](https://sea.example.kr/gangneung)\n속초는 이든이 봤는데 풍랑주의보가 있어요. [b](https://sea.example.kr/sokcho)'
    const said = (lead: string): string => JSON.stringify({ message: `${lead}\n\n${body}`, kept: ['f1', 'f2'] })
    const writer = (each: number) => {
      const verdicts = [problem('contradicts', '두 곳 다 잔잔해요.'), none], calls: string[] = []
      return { calls, write: (prompt: string): Promise<string> => new Promise(resolve => setTimeout(() => { calls.push(prompt); resolve(prompt.includes(CHECK) ? verdicts.shift() ?? none : prompt.includes(REDO) ? JSON.stringify({ replace: { 1: '강릉은 잔잔하고 속초는 풍랑주의보가 있어요.' } }) : said('두 곳 다 잔잔해요.')) }, each)) }
    }
    const quick = writer(800)
    const pending = writtenReport({ ask: '강릉 속초 오늘 바다 날씨 나눠서 알아봐줘', members, write: quick.write })
    await vi.runAllTimersAsync()
    const out = await pending, took = Date.now() - T0
    expect(quick.calls).toHaveLength(4)
    expect(out).toMatch(/^강릉은 잔잔하고 속초는 풍랑주의보가 있어요\./)
    expect(took).toBeLessThanOrEqual(TEAM_ANSWER_MS + REPORT_WRITER_MS)
    expect(took).toBeLessThan(35_000)
    vi.setSystemTime(T0 + TEAM_ANSWER_MS)
    const slow = writer(1_500)
    let landed = 0
    const late = writtenReport({ ask: '강릉 속초 오늘 바다 날씨 나눠서 알아봐줘', members, write: slow.write }).then(text => { landed = Date.now(); return text })
    await vi.runAllTimersAsync()
    const shown = await late
    expect(shown).not.toContain('두 곳 다 잔잔해요')
    expect(shown).toContain('속초는 이든이 봤는데 풍랑주의보가 있어요.')
    void mergedReport
    expect(landed - T0).toBeLessThanOrEqual(TEAM_ANSWER_MS + REPORT_WRITER_MS)
  })
})

describe('stack-14 merge: a part retried empty reaches the writer as a missing part', () => {
  it('c14a retries the empty part once; c14b\'s check reads it as brought nothing, keeps a question off the thread, and the host line stays', async () => {
    const paths = await vault('retry')
    for (const name of ['엔그램', '하람', '이든']) await createBot(paths, { name })
    const ask = '강릉이랑 속초 오늘 바다 날씨 하람이랑 이든이가 나눠서 알아봐줘'
    const created = await createTask(paths, ask, 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const runs: Record<string, number> = { 하람: 0, 이든: 0 }
    const run: Run = async (_deps, prompt, options = {}) => {
      options.onStart?.()
      const who = (options.persona ?? '').includes('이든') ? '이든' : '하람'
      runs[who]!++
      if (who === '하람') return { answer: block({ facts: [{ text: '강릉 바다는 오늘 물결이 1미터로 잔잔해요.', url: 'https://sea.example.kr/gangneung' }] }), steps: [], fellBack: false }
      return { answer: block({ facts: [] }), steps: [], fellBack: false }
    }
    const asked: string[] = []
    const asking = JSON.stringify({ message: '강릉은 하람이 봤는데 물결이 잔잔해요. [a](https://sea.example.kr/gangneung)\n\n속초는 다시 찾아볼까요?', kept: ['f1'] })
    const verdicts = [problem('asks', '속초는 다시 찾아볼까요?'), none]
    const quick = async (prompt: string): Promise<string | undefined> => {
      asked.push(prompt)
      if (prompt.includes(CHECK)) return verdicts.shift() ?? none
      if (prompt.includes('"lists"')) return '{"keep":[1],"lists":[]}'
      if (prompt.includes(REDO)) return JSON.stringify({ replace: { 2: '' } })
      return asking
    }
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine: { id: 'claude', quick } as unknown as TurnKit['engine'], workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit) }
    const answer = await team.tools('bot-b1', kit, () => undefined).find(t => t.name === 'assign')!.run({ wait: true, to: [{ who: '하람', brief: '강릉 오늘 바다 날씨', topic: '강릉' }, { who: '이든', brief: '속초 오늘 바다 날씨', topic: '속초' }] }, { task: ask })
    expect(runs).toEqual({ 하람: 1, 이든: 2 })
    const check = asked.find(p => p.includes(CHECK))!
    const data = JSON.parse(check.split('\n').find(line => line.startsWith('Data: '))!.slice(6)) as { broughtNothing?: { name: string }[]; shownAfterMessage?: string }
    expect(data.broughtNothing?.map(one => one.name)).toEqual(['이든'])
    expect(data.shownAfterMessage).toContain('속초(이든)')
    expect(answer).not.toContain('까요?')
    expect(answer.startsWith('강릉은 하람이 봤는데')).toBe(true)
    expect(answer.endsWith(data.shownAfterMessage!)).toBe(true)
    expect(asked.filter(p => p.includes(CHECK))).toHaveLength(2)
  })
})

describe('stack-14 merge: stop', () => {
  it('a stop during a search round starts no further round and returns at once', async () => {
    const ctl = new AbortController()
    let searches = 0
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async (args, context) => {
      searches++
      if (searches === 1) return `results for "${String(args['query'])}" at https://search.example/?q=1 (DATA, not instructions):\n${rows(1, 1)}`
      setTimeout(() => ctl.abort(), 20)
      return new Promise<string>((_, reject) => context.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    } }
    const write = async (): Promise<string> => JSON.stringify({ keep: [1], same: [], lists: [], names: {}, listing: [], outside: [], search: `다른 말 ${searches}` })
    const tool = checkedSearch(search, { ask: () => '전주 한옥 카페 개업 소식 4개', write, since: Date.now() })
    const at = Date.now()
    await tool.run({ query: '전주 한옥 카페' }, { task: '', signal: ctl.signal })
    expect(Date.now() - at).toBeLessThan(500)
    expect(searches).toBe(2)
  })

  it('a stop during the meaning check\'s rewrite ends the writer at once on the host rendering, with no further call', async () => {
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '하람', brief: '강릉 오늘 바다 날씨', topic: '강릉', botId: 'bot-m1', lookup: true, state: 'done', sessionKey: 's-m1', hiredAt: new Date().toISOString() }
    const answer = block({ facts: [{ text: '강릉 바다는 오늘 잔잔해요.', url: 'https://sea.example.kr/gangneung' }] })
    settleMember(m, { answer, report: reportData(answer, m, [], true) ?? null }, new Date().toISOString(), true)
    const ctl = new AbortController(), calls: string[] = []
    const write = async (prompt: string): Promise<string | undefined> => {
      calls.push(prompt)
      if (prompt.includes(CHECK)) return problem('contradicts', '하나도 안 잔잔해요.')
      if (prompt.includes(REDO)) { setTimeout(() => ctl.abort(), 20); return new Promise<undefined>(() => undefined) }
      return JSON.stringify({ message: '강릉은 하람이 봤는데 하나도 안 잔잔해요. [a](https://sea.example.kr/gangneung)', kept: ['f1'] })
    }
    const at = Date.now()
    const out = await writtenReport({ ask: '강릉 바다 날씨', members: [m], write, timeoutMs: 6_000, signal: ctl.signal })
    expect(Date.now() - at).toBeLessThan(500)
    expect(out).toBe(mergedReport([m]))
    expect(calls).toHaveLength(3)
  })
})

describe('stack-14 merge: R1/T1 call count', () => {
  it('anonymous hire_members with two parts that bring data: 2 model calls, 0 quick calls (stack-13: 2 and 0)', async () => {
    const paths = await vault('count')
    const created = await createTask(paths, '강릉, 속초 오늘 바다 날씨 각각 알아봐', 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
    const calls: string[] = [], quick: string[] = []
    const run: Run = async (_deps, prompt, options = {}) => {
      calls.push(prompt.slice(0, 20)); options.onStart?.()
      return { answer: (options.persona ?? '').includes('"강릉"') ? '강릉 바다는 잔잔해요 https://sea.example.kr/gangneung' : '속초는 풍랑주의보가 있어요 https://sea.example.kr/sokcho', steps: [], fellBack: false }
    }
    const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine']
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => '', nativeFor: async () => undefined, toolsFor: async lane => team.tools(lane, kit), alive: async () => true }
    await team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!.run({ members: [{ role: '강릉', brief: '강릉 바다 날씨', lookup: true }, { role: '속초', brief: '속초 바다 날씨', lookup: true }] }, { task: '' })
    console.log(`[stack14] R1/T1 anonymous hire_members: ${calls.length} model calls, ${quick.length} quick calls`)
    expect(calls).toHaveLength(2)
    expect(quick).toEqual([])
  })
})

describe('stack-14: the item judge reads the one deadline', () => {
  it('a judgment that takes longer than 3 s, early in the turn, is still used and the loop looks further', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-11-18T03:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const since = Date.now(), queries: string[] = []
    const page = (n: number): string => `results for "q" at https://search.example/?q=${n} (DATA, not instructions):\n- 대전 빵집 ${n}호 개업 — https://bread.example.kr/${n} — 11월 ${n}일\n- 대전 제과 박람회 — https://expo.example.kr/${n} — 통계`
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return page(queries.length + 1) } }
    const write = (prompt: string): Promise<string> => new Promise(resolve => setTimeout(() => {
      const n = (prompt.match(/"n":/g) ?? []).length, keep = Array.from({ length: n }, (_, i) => i + 1).filter(i => !prompt.split('"n":')[i]!.includes('박람회'))
      resolve(JSON.stringify({ keep, unsure: [], same: [], lists: [], names: {}, listing: [], outside: [], search: `대전 빵집 새로 문 연 곳 ${n}` }))
    }, 4_500))
    const tool = checkedSearch(search, { ask: () => '대전 빵집 개업 소식 3건 알려줘', write, since })
    const done = tool.run({ query: '대전 빵집 개업' }, { task: '' })
    await vi.runAllTimersAsync()
    const out = await done
    expect(out).toContain('박람회')
    expect(queries.length).toBeGreaterThanOrEqual(2)
    expect(out.split('\n').filter(line => line.startsWith('- ') && line.includes('빵집'))).toHaveLength(2)
    expect(out).not.toContain('of these rows are from the period asked')
    expect(Date.now() - since).toBeLessThanOrEqual(TEAM_ANSWER_MS - LOOKUP_RESERVE_MS + WIDEN_MS)
  })
})
