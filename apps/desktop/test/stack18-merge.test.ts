import { mkdir, mkdtemp } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, handBacks, runToolSession, setReportLog, updateTask, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Report = { who: string; part?: string; state: string; result: string; sources?: string[] }
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-s18-${tag}-`)), '.engram') } as unknown as VaultPaths }
const count = (text: string, part: string): number => text.split(part).length - 1
const ipc = readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
const handed = (members: TeamMember[]): { reports: Report[]; note: string } => JSON.parse(handBacks(members)) as { reports: Report[]; note: string }
const lead = async (draft: string, ask: string): Promise<{ answer: string; quick: number }> => {
  let quick = 0
  const out = await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }), quick: async () => { quick++; return '' } } as never, workdir: '/x', tools: [] }, ask, {})
  return { answer: out.answer, quick }
}
afterEach(() => { vi.useRealTimers(); setReportLog(() => undefined) })

const at = new Date().toISOString()
const looker = (id: string, topic: string, rest: Partial<TeamMember>): TeamMember => ({ id, parentId: null, depth: 1, role: `${topic} 조사`, topic, brief: `${topic} 알아봐`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: `s-${id}`, hiredAt: at, result: 'x', ...rest })
const WEATHER = { 춘천: 'https://weather.example/chuncheon', 원주: 'https://weather.example/wonju' }

describe('stack-18: kept facts reach the sentence fallback (c18a keep → c18b host sentences)', () => {
  const CHUNCHEON = `춘천은 내일 낮 최고 9도예요. [춘천 날씨](${WEATHER.춘천}) 춘천 모레는 첫눈 소식이 있어요. [뉴스](https://news.example/chuncheon-snow)`, WONJU = `원주는 내일 낮 최고 11도예요. [원주 날씨](${WEATHER.원주})`
  const members = (state: Partial<TeamMember>): TeamMember[] => [
    looker('h1', '춘천', { result: CHUNCHEON, said: CHUNCHEON, sources: [WEATHER.춘천, 'https://search.example/?q=%EC%B6%98%EC%B2%9C'], ...state }),
    looker('h2', '원주', { result: WONJU, said: WONJU, sources: [WEATHER.원주], ...state }),
  ]
  it.each([['released after its lookup was accepted', {}], ['done and not yet reviewed', { state: 'done', review: undefined }]] as const)('a helper %s: each part reaches the lead as its own sentences with every link it wrote, and no sentence is made by the host', (_what, state) => {
    const got = handed(members(state as Partial<TeamMember>))
    expect(got.reports.map(one => one.result)).toEqual([CHUNCHEON, WONJU])
    expect(got.reports[0]!.result).toContain('news.example/chuncheon-snow')
    expect(got.reports.map(one => one.sources)).toEqual([[WEATHER.춘천, 'https://search.example/?q=%EC%B6%98%EC%B2%9C'], [WEATHER.원주]])
    expect(got.reports.map(one => one.state)).toEqual(['done', 'done'])
    expect(JSON.stringify(got.reports)).not.toMatch(/\|/)
    expect(Object.keys(got)).toEqual(['reports', 'note'])
  })
})

describe('stack-18: "못 찾았어요" agrees (c18a missing × c18b writer and fallback)', () => {
  const WONJU = '원주 시립미술관은 어른 관람료 2천 원이에요. [원주 미술관](https://museum.example/wonju)\n운영시간은 안내가 없었어요.'
  const members = (): TeamMember[] => [
    looker('h1', '춘천', { result: '춘천 시립미술관은 어른 관람료 3천 원이에요. [춘천 미술관](https://museum.example/chuncheon)', sources: ['https://museum.example/chuncheon'] }),
    looker('h2', '원주', { result: WONJU, sources: ['https://museum.example/wonju'] }),
  ]
  const ASK = '춘천 원주 시립미술관 관람료랑 운영시간 알려줘'
  it('the writer path: the missing point is said once, in the helper\'s own sentence of its part, and the lead\'s reply that says it once is posted as written', async () => {
    const got = handed(members())
    expect(count(JSON.stringify(got.reports), '운영시간')).toBe(1)
    expect(got.reports[1]!.result).toBe(WONJU)
    expect(JSON.stringify(got.reports)).not.toContain('못 찾았어요')
    const draft = '관람료는 두 곳 다 확인했고 원주 운영시간만 안내가 없었어요.\n\n춘천은 어른 3천 원이에요. [춘천 미술관](https://museum.example/chuncheon)\n원주는 어른 2천 원이에요. [원주 미술관](https://museum.example/wonju)'
    const shown = await lead(draft, ASK)
    expect(shown).toEqual({ answer: draft, quick: 0 })
    expect(count(shown.answer, '운영시간')).toBe(1)
  })
  it('there is no fallback text: the hand-back is given only to the lead\'s step in the turn context, and saying a missing point is the model\'s rule', () => {
    expect(ipc).toContain('handedBack ? `${HANDED_BACK}\\n${handedBack}` : \'\'')
    expect(ipc.split('\n').filter(line => line.includes('handedBack')).every(line => !/broadcast\(|appendBotTurn\(/.test(line))).toBe(true)
    expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place')
    expect(handed(members()).note).toContain('Say plainly which part failed or is missing.')
  })
})

describe('stack-18: repair vs evidence on a team report (c18b scoped repair × c18a evidenced value)', () => {
  const EVIDENCED = `하람이 찾아보니 춘천은 내일 낮 최고 9도예요. [춘천 날씨](${WEATHER.춘천})`, OTHER = `누리가 찾아보니 원주는 내일 맑아요. [원주 날씨](${WEATHER.원주})`
  it.each([['in the same message', ' '], ['in a message of its own', '\n\n']] as const)('a lead sentence the pages do not back, %s: nothing after the model takes it out or rewrites it, and the evidenced sentences and links stay byte-equal', async (_what, gap) => {
    const draft = `두 곳 다 우산은 필요 없어요.${gap}${EVIDENCED}\n${OTHER}`
    const shown = await lead(draft, '하람이랑 누리가 춘천 원주 내일 하늘 상태 확인')
    expect(shown).toEqual({ answer: draft, quick: 0 })
    expect(shown.answer.split('\n')).toContain(OTHER)
    expect(shown.answer).toContain(EVIDENCED)
    expect(COLLEAGUE_CORE_RULE).toContain('Your reply reaches the person exactly as you write it, so write it finished: nobody tidies, checks or completes it after you.')
    const from = ipc.indexOf('await lookup.run(')
    expect(ipc.slice(from, ipc.indexOf('answerDelivered = true', from)).match(/result\.answer = /g)).toHaveLength(1)
  })
})

const TOWNS = ['춘천', '원주', '강릉', '속초']
const FEE = (town: string): string => `https://museum.example/${encodeURIComponent(town)}/fee`
const results = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const town = (text: string): string => TOWNS.find(one => text.includes(one)) ?? '춘천'
const own = (place: string): string => `${place} 시립미술관은 어른 관람료 3천 원이에요. [${place} 시립미술관](${FEE(place)})`
type Timing = { searchMs: number; modelMs: number }
const REAL: Timing = { searchMs: 1500, modelMs: 3000 }

async function lane(tag: string, towns: string[], timing: Timing, hooks: { onSearch?: () => void; onModel?: () => void } = {}) {
  const paths = await vault(tag), ask = `${towns.join(' ')} 시립미술관 어른 관람료 알려줘`
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1; t.team = { members: [], hires: 0, maxHires: 8, maxDepth: 3, big: true, approvedAt: new Date().toISOString() } })
  const calls: { kind: string; at: number }[] = []
  const wait = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true }) })
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async (args, context) => {
    const q = String(args['query']), place = town(q); calls.push({ kind: 'search', at: Date.now() }); hooks.onSearch?.(); await wait(timing.searchMs, context.signal)
    return results(q, [`- ${place} 시립미술관 관람 안내 — ${FEE(place)} — 어른 관람료 3천 원 — 11월 20일`])
  } }
  const run: Run = async (deps, prompt, options = {}) => {
    options.onStart?.(); calls.push({ kind: 'model', at: Date.now() })
    const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', place = town(part)
    const tool = deps.tools?.find(t => t.name === 'search_web')
    if (tool) await tool.run({ query: `${place} 시립미술관 관람료` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) })
    hooks.onModel?.()
    await wait(timing.modelMs, options.signal)
    return { answer: own(place), steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async () => { calls.push({ kind: 'quick', at: Date.now() }); return undefined } } as unknown as TurnKit['engine']
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search] }
  const since = Date.now(), stop = new AbortController()
  const hire = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
  const members = towns.map(place => ({ role: `${place} 조사`, topic: place, brief: `${place} 시립미술관 어른 관람료`, lookup: true }))
  return { hire, calls, since, stop, members }
}

async function drive<T>(work: Promise<T>, step = 20): Promise<T> {
  let done = false
  void work.finally(() => { done = true }).catch(() => undefined)
  while (!done) { await vi.advanceTimersByTimeAsync(step); await new Promise(resolve => setImmediate(resolve)) }
  return work
}
const fake = (): void => { vi.useFakeTimers({ now: Date.parse('2026-11-18T03:00:00Z'), toFake: ['Date', 'setTimeout', 'clearTimeout'] }) }

describe('stack-18: one clock on the anonymous split (c18a page opens × c18b scoped repair, fake time)', () => {
  it.each([[4, 40_000], [3, 35_000]] as const)('a %i-part split hands every helper\'s own words to the lead in time, with one model call a part and none by the host', async (n, bound) => {
    fake()
    const { hire, calls, since, members } = await lane(`clock${n}`, TOWNS.slice(0, n), REAL)
    const text = await drive(hire.run({ members: members }, { task: '' }))
    const took = Date.now() - since
    expect(took).toBeLessThan(bound)
    expect(hire.closesOn?.(text) ?? false).toBe(false)
    expect((JSON.parse(text) as { members: { result: string }[] }).members.map(m => m.result)).toEqual(TOWNS.slice(0, n).map(own))
    expect(calls.filter(c => c.kind === 'model')).toHaveLength(n)
    expect(calls.filter(c => c.kind === 'quick')).toHaveLength(0)
  }, 30_000)
})

describe('stack-18: "멈춰" during a page open or a scoped repair ends at once and nothing follows', () => {
  it.each([['a helper\'s search', 'search'], ['a helper\'s writing', 'model']] as const)('"멈춰" during %s halts within 3 s and no model call follows', async (_what, where) => {
    let stoppedAt = 0, atStop = 0, armed = false
    const box: { stop?: AbortController; calls?: { kind: string }[] } = {}
    const halt = (): void => { if (armed) return; armed = true; setTimeout(() => { stoppedAt = Date.now(); atStop = box.calls!.length; box.stop!.abort() }, 200) }
    const slow = { searchMs: where === 'search' ? 6000 : 20, modelMs: 6000 }
    const { hire, calls, stop, members } = await lane(`stop-${where}`, TOWNS.slice(0, 3), slow, where === 'search' ? { onSearch: halt } : { onModel: halt })
    box.stop = stop; box.calls = calls
    const out = await hire.run({ members }, { task: '', signal: stop.signal }).catch(() => '')
    expect(stoppedAt).toBeGreaterThan(0)
    expect(Date.now() - stoppedAt).toBeLessThan(3000)
    for (const place of TOWNS.slice(0, 3)) expect(out).not.toContain(own(place))
    expect(calls.length).toBe(atStop)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(calls.length).toBe(atStop)
  }, 30_000)
})
