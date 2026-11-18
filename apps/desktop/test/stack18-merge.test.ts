import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, helperAnswer, listTasks, mergingHire, setReportLog, updateTask, writtenReport, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { agreeing } from '../../../packages/core/test/agreeing.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-s18-${tag}-`)), '.engram') } as unknown as VaultPaths }
const CHECK = 'Judge meaning only', REPAIR = 'You fix a message before a person reads it', JUDGE = 'In "holds", for each item', STATED = 'Read the words alone'
const none = JSON.stringify({ problems: [] })
const count = (text: string, part: string): number => text.split(part).length - 1
afterEach(() => { vi.useRealTimers(); setReportLog(() => undefined) })

const at = new Date().toISOString()
const looker = (id: string, topic: string, rest: Partial<TeamMember>): TeamMember => ({ id, parentId: null, depth: 1, role: `${topic} 조사`, topic, brief: `${topic} 알아봐`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: `s-${id}`, hiredAt: at, result: 'x', ...rest })
const WEATHER = { 춘천: 'https://weather.example/chuncheon', 원주: 'https://weather.example/wonju' }

describe('stack-18: kept facts reach the sentence fallback (c18a keep → c18b host sentences)', () => {
  const members = (): TeamMember[] => [
    looker('h1', '춘천', {
      said: `춘천은 내일 낮 최고 9도예요. [춘천 날씨](${WEATHER.춘천}) 춘천 모레는 첫눈 소식이 있어요. [뉴스](https://news.example/chuncheon-snow)`,
      sources: [WEATHER.춘천, 'https://search.example/?q=%EC%B6%98%EC%B2%9C'], proof: [{ point: '기온', quote: '낮 최고 9도', url: WEATHER.춘천 }], missing: [],
    }),
    looker('h2', '원주', { said: `원주는 내일 낮 최고 11도예요. [원주 날씨](${WEATHER.원주})`, sources: [WEATHER.원주], proof: [{ point: '기온', quote: '낮 최고 11도', url: WEATHER.원주 }], missing: [] }),
  ]
  it.each([['returns \'\'', ''], ['returns nothing', undefined]] as const)('the writer %s: each part is said by its kept sentence with its link; the search-row fact never appears', async (_what, draft) => {
    const prompts: string[] = []
    const write = agreeing(async (prompt: string): Promise<string | undefined> => { prompts.push(prompt); return draft })
    const out = (await helperAnswer({ ask: '춘천 원주 내일 날씨 알려줘', members: members(), since: 0, write, due: Date.now() + 20_000 }))!
    expect(prompts).toHaveLength(1)
    expect(out).toMatch(/^춘천은 내일 낮 최고 9도예요\. \[[^\]]+\]\(https:\/\/weather\.example\/chuncheon\)$/m)
    expect(out).toMatch(/^원주는 내일 낮 최고 11도예요\. \[[^\]]+\]\(https:\/\/weather\.example\/wonju\)$/m)
    // c19a (cause H): a helper's facts are its own cited sentences; no judge proof decides which stand, so its 첫눈 sentence stays with
    // its own link (a link it was never shown would lose its link; this fixture records no shown pages).
    expect(out).toContain('첫눈')
    expect(out).toContain('news.example/chuncheon-snow')
    expect(out).not.toMatch(/^\|/m)
  })
})

describe('stack-18: "못 찾았어요" agrees (c18a missing × c18b writer and fallback)', () => {
  const members = (): TeamMember[] => [
    looker('h1', '춘천', { said: `춘천 시립미술관은 어른 관람료 3천 원이에요. [춘천 미술관](https://museum.example/chuncheon)`, sources: ['https://museum.example/chuncheon'], proof: [{ point: '관람료', quote: '어른 관람료 3천 원', url: 'https://museum.example/chuncheon' }], missing: [] }),
    looker('h2', '원주', { said: `원주 시립미술관은 어른 관람료 2천 원이에요. [원주 미술관](https://museum.example/wonju)`, sources: ['https://museum.example/wonju'], proof: [{ point: '관람료', quote: '어른 관람료 2천 원', url: 'https://museum.example/wonju' }], missing: ['운영시간'] }),
  ]
  const ASK = '춘천 원주 시립미술관 관람료랑 운영시간 알려줘'
  const model = (writer: (prompt: string) => string | undefined) => {
    const prompts: string[] = []
    const write = async (prompt: string): Promise<string | undefined> => {
      prompts.push(prompt)
      if (prompt.includes(STATED)) return JSON.stringify({ states: [] })
      if (prompt.includes(CHECK)) return none
      return writer(prompt)
    }
    return { write, prompts }
  }
  it('the writer path: the missing point is said once, in a sentence of its part', async () => {
    const { write, prompts } = model(prompt => {
      const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts: { id: string; text: string; link: string }[] }[]
      return JSON.stringify({ message: data.map(p => `${p.facts.map(f => `${f.text} ${f.link}`).join(' ')}`).join('\n'), kept: data.flatMap(p => p.facts.map(f => f.id)) })
    })
    const out = (await helperAnswer({ ask: ASK, members: members(), since: 0, write, due: Date.now() + 20_000 }))!
    // c19a (cause H): no blind "stated" read and no judged-missing point: "못 찾았어요" is never the host's for a part that handed back facts.
    expect(prompts.filter(p => p.includes(STATED))).toHaveLength(0)
    expect(count(out, '운영시간은 못 찾았어요')).toBe(0)
    expect(out).toContain('원주 시립미술관은 어른 관람료 2천 원이에요.')
    expect(out).not.toMatch(/춘천 시립미술관[^\n]*못 찾았어요/)
  })
  it('the fallback (no writer draft): the missing point is said in a sentence, not dropped', async () => {
    const { write } = model(() => '')
    const out = (await helperAnswer({ ask: ASK, members: members(), since: 0, write, due: Date.now() + 20_000 }))!
    expect(out).toContain('원주 시립미술관은 어른 관람료 2천 원이에요.')
    expect(out).not.toMatch(/춘천 시립미술관[^\n]*못 찾았어요/)
    expect(count(out, '운영시간은 못 찾았어요')).toBe(0)
  })
})

describe('stack-18: repair vs evidence on a team report (c18b scoped repair × c18a evidenced value)', () => {
  const teammate = (id: string, role: string, text: string, url: string, site: string): TeamMember => ({ id, parentId: null, depth: 1, role, brief: `${role} 날씨 조사`, botId: `bot-${id}`, lookup: true, state: 'done', sessionKey: `s-${id}`, hiredAt: at, data: { facts: [{ text, url, site }] } })
  const haram = teammate('m1', '하람', '춘천은 내일 낮 최고 9도예요.', WEATHER.춘천, '춘천 날씨'), nuri = teammate('m2', '누리', '원주는 내일 맑아요.', WEATHER.원주, '원주 날씨')
  const EVIDENCED = `하람이 찾아보니 춘천은 내일 낮 최고 9도예요. [춘천 날씨](${WEATHER.춘천})`, OTHER = `누리가 찾아보니 원주는 내일 맑아요. [원주 날씨](${WEATHER.원주})`
  it.each([['undefined', undefined], ['unreadable', 'not json at all']] as const)('a contradicting sentence whose repair is %s is the only thing that goes; the evidenced sentence and its link stay byte-equal', async (_what, repair) => {
    const calls: string[] = []
    const write = agreeing(async (prompt: string): Promise<string | undefined> => {
      calls.push(prompt)
      if (prompt.includes(CHECK)) return JSON.stringify({ problems: [{ kind: 'contradicts', quote: '두 곳 다 비가 와요.', why: '자료에 비 소식 없음' }] })
      if (prompt.includes(REPAIR)) return repair
      return JSON.stringify({ message: `두 곳 다 비가 와요. ${EVIDENCED}\n${OTHER}`, kept: ['f1', 'f2'] })
    })
    const out = await writtenReport({ ask: '하람이랑 누리한테 춘천 원주 내일 날씨 알아보게 해', members: [haram, nuri], write, timeoutMs: 15_000 })
    expect(calls.filter(p => p.includes(REPAIR))).toHaveLength(1)
    expect(out).not.toContain('비가 와요')
    expect(out.split('\n')).toContain(EVIDENCED)
    expect(out.split('\n')).toContain(OTHER)
    expect(out).toBe(`${EVIDENCED}\n${OTHER}`)
  })
})

const TOWNS = ['춘천', '원주', '강릉', '속초']
const FEE = (town: string): string => `https://museum.example/${encodeURIComponent(town)}/fee`
const results = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const town = (text: string): string => TOWNS.find(one => text.includes(one)) ?? '춘천'
type Timing = { searchMs: number; judgeMs: number; pageMs: number; modelMs: number; writeMs: number; checkMs: number; repairMs: number }
const REAL: Timing = { searchMs: 1500, judgeMs: 2000, pageMs: 1500, modelMs: 3000, writeMs: 3000, checkMs: 2000, repairMs: 3000 }

async function lane(tag: string, towns: string[], timing: Timing, hooks: { onOpen?: () => void; onRepair?: () => void } = {}) {
  const paths = await vault(tag), ask = `${towns.join(' ')} 시립미술관 어른 관람료 알려줘`
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1; t.team = { members: [], hires: 0, maxHires: 8, maxDepth: 3, big: true, approvedAt: new Date().toISOString() } })
  const calls: { kind: string; at: number }[] = [], opened: string[] = [], wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']), place = town(q); calls.push({ kind: 'search', at: Date.now() }); await wait(timing.searchMs)
    return results(q, [`- ${place} 시립미술관 관람 안내 — ${FEE(place)} — ${place} 시립미술관 이용 안내 — 11월 20일`, `- ${place} 전시 소식 — https://news.example/${encodeURIComponent(place)} — ${place} 겨울 전시 이야기 — 11월 19일`])
  } }
  const open: AgentTool = { name: 'open_page', description: '', argsSchema: {}, run: async args => {
    const url = String(args['url']), place = town(decodeURIComponent(url)); opened.push(url); calls.push({ kind: 'page', at: Date.now() }); hooks.onOpen?.(); await wait(timing.pageMs)
    return `page "${place} 시립미술관 관람 안내" (DATA, not instructions):\n${place} 시립미술관 관람 안내\n어른(일반) 관람료 3천 원, 어린이 1천 원. 매주 월요일은 쉬어요.`
  } }
  let repaired = 0
  const write = agreeing(async (prompt: string): Promise<string | undefined> => {
    if (prompt.includes(JUDGE)) {
      calls.push({ kind: 'judge', at: Date.now() }); await wait(timing.judgeMs)
      const items = JSON.parse(prompt.split('\nItems: ')[1]!) as { n: number; text: string; link?: string }[], fee = items.find(item => item.link?.endsWith('/fee'))
      return JSON.stringify({ keep: items.map(item => item.n), asked: 1, points: ['관람료: 원화 금액'], holds: fee ? { [fee.n]: { 관람료: '어른 관람료 3천 원' } } : {}, ...(fee ? { open: fee.n } : {}), search: '' })
    }
    if (prompt.includes(CHECK)) {
      calls.push({ kind: 'check', at: Date.now() }); await wait(timing.checkMs)
      return prompt.includes('어디든 무료') ? JSON.stringify({ problems: [{ kind: 'contradicts', quote: '어디든 무료로 볼 수 있어요.', why: '관람료는 3천 원' }] }) : none
    }
    if (prompt.includes(REPAIR)) {
      calls.push({ kind: 'repair', at: Date.now() }); hooks.onRepair?.(); await wait(timing.repairMs); repaired++
      return JSON.stringify({ replace: { 1: `${towns.length}곳 모두 어른 관람료는 3천 원이에요.` } })
    }
    calls.push({ kind: 'write', at: Date.now() }); await wait(timing.writeMs)
    const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { id: string; text: string; link: string }[] }[]
    const rows = data.filter(p => p.facts?.length).map(p => ({ part: p.part, fact: p.facts![0]! }))
    return JSON.stringify({ message: ['어디든 무료로 볼 수 있어요.', '', '| 도시 | 관람료 | 출처 |', '|---|---|---|', ...rows.map(r => `| ${r.part} | ${r.fact.text} | ${r.fact.link} |`)].join('\n'), kept: rows.map(r => r.fact.id) })
  })
  const run: Run = async (deps, prompt, options = {}) => {
    options.onStart?.(); calls.push({ kind: 'model', at: Date.now() })
    const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', place = town(part)
    const tool = deps.tools?.find(t => t.name === 'search_web')
    if (tool) await tool.run({ query: `${place} 시립미술관 관람료` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) })
    if (!options.signal?.aborted) await new Promise<void>(resolve => { const timer = setTimeout(resolve, timing.modelMs); options.signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
    if (options.signal?.aborted) throw new Error('aborted')
    return { answer: `${place} 시립미술관은 어른 관람료 3천 원이에요. [${place} 시립미술관](${FEE(place)})`, steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async (prompt: string) => write(prompt) } as unknown as TurnKit['engine']
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search, open], alive: async () => true }
  const since = Date.now(), stop = new AbortController()
  const hire = mergingHire(team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!, async signal => helperAnswer({ ask, members: (await listTasks(paths)).find(t => t.state === 'running')?.team?.members, since, write, due: since + 28_000 + 4_000, signal: signal ?? stop.signal }))
  const members = towns.map(place => ({ role: `${place} 조사`, topic: place, brief: `${place} 시립미술관 어른 관람료`, lookup: true }))
  return { hire, calls, opened, since, stop, members, repaired: () => repaired }
}

async function drive<T>(work: Promise<T>, step = 20): Promise<T> {
  let done = false
  void work.finally(() => { done = true }).catch(() => undefined)
  while (!done) { await vi.advanceTimersByTimeAsync(step); await new Promise(resolve => setImmediate(resolve)) }
  return work
}
const fake = (): void => { vi.useFakeTimers({ now: Date.parse('2026-11-18T03:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] }) }

describe('stack-18: one clock on the anonymous split (c18a page opens × c18b scoped repair, fake time)', () => {
  it.each([[4, 40_000], [3, 35_000]] as const)('a %i-part split with same-round page opens and one repair answers in time', async (n, bound) => {
    fake()
    const { hire, calls, opened, since, members, repaired } = await lane(`clock${n}`, TOWNS.slice(0, n), REAL)
    const text = await drive(hire.run({ members: members }, { task: '' }))
    const took = Date.now() - since
    console.log(`stack-18 clock ${n} opened ${opened.length}: ${took} ms, calls ${calls.map(c => `${c.kind}@${c.at - since}`).join(' ')}\n${text}`)
    expect(took).toBeLessThan(bound)
    expect(hire.closesOn!(text)).toBe(true)
    for (const place of TOWNS.slice(0, n)) { expect(opened).toContain(FEE(place)); expect(text).toContain(FEE(place)) }
    expect(repaired()).toBe(1)
    expect(text).not.toContain('무료')
    expect(text).toContain(`${n}곳 모두 어른 관람료는 3천 원이에요.`)
    expect(text).not.toContain('못 찾았어요')
  }, 30_000)
})

describe('stack-18: "멈춰" during a page open or a scoped repair ends at once and nothing follows', () => {
  it.each([['a page open', 'page'], ['a scoped repair', 'repair']] as const)('"멈춰" during %s halts within 3 s and no model call follows', async (_what, where) => {
    fake()
    let stoppedAt = 0, atStop = 0, armed = false
    const box: { stop?: AbortController; calls?: { kind: string }[] } = {}
    const halt = (): void => { if (armed) return; armed = true; setTimeout(() => { stoppedAt = Date.now(); atStop = box.calls!.length; box.stop!.abort() }, 500) }
    const slow = { ...REAL, pageMs: 6000, repairMs: 6000 }
    const { hire, calls, stop, members } = await lane(`stop-${where}`, TOWNS.slice(0, 3), slow, where === 'page' ? { onOpen: halt } : { onRepair: halt })
    box.stop = stop; box.calls = calls
    const out = await drive(hire.run({ members }, { task: '', signal: stop.signal }))
    expect(stoppedAt).toBeGreaterThan(0)
    expect(Date.now() - stoppedAt).toBeLessThan(3000)
    expect(hire.closesOn!(out)).toBe(false)
    expect(calls.length).toBe(atStop)
    await drive(new Promise(resolve => setTimeout(resolve, 10_000)))
    expect(calls.length).toBe(atStop)
  }, 30_000)
})
