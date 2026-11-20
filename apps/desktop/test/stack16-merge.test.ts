import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBot, createTask, employeeWriteBack, handBacks, loadBots, MERGED_SHAPE, runToolSession, settleMember, teamSummary, withLiveSources, setReportLog, updateTask, type AgentTool, type TeamMember, type VaultPaths } from 'core'
import * as core from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import * as desk from '../src/main/desk-lane.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { WORK_REPLY_RULE } from '../../../packages/core/src/agent-session-shape.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type View = { id: string; role: string; state: string; result?: string; sources?: string[]; accepted?: boolean }
type Handed = { members: View[]; note: string }
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-s16-${tag}-`)), '.engram') } as unknown as VaultPaths }
const PAGE: Record<string, string> = { 강릉: 'https://surf.example/gangneung', 속초: 'https://surf.example/sokcho', 양양: 'https://surf.example/yangyang', 고성: 'https://surf.example/goseong' }
const results = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
afterEach(() => { vi.useRealTimers(); setReportLog(() => undefined) })
const tick = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true }) })
const own = (town: string): string => `${town}은 이번 주말 파도가 1m 안팎이에요. [${town} 파도 예보](${PAGE[town]})`

async function lane(tag: string, ask: string, opts: { searchMs?: number; modelMs?: number; steer?: number; silent?: string } = {}) {
  const paths = await vault(tag)
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const models: string[] = [], quick: string[] = [], searches: string[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async (args, context) => {
    const q = String(args['query']); searches.push(q); await tick(opts.searchMs ?? 0, context.signal)
    const town = Object.keys(PAGE).find(name => q.includes(name)) ?? '강릉'
    return results(q, [`- ${town} 이번 주말 파도 1m 안팎 — ${PAGE[town]} — 예보 — 11월 20일`])
  } }
  const run: Run = async (deps, prompt, options = {}) => {
    options.onStart?.()
    const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', town = Object.keys(PAGE).find(name => part.includes(name)) ?? '강릉'
    models.push(town)
    const tool = deps.tools?.find(t => t.name === 'search_web')
    if (tool) await tool.run({ query: `${town} 서핑 파도` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) })
    await tick(opts.modelMs ?? 0, options.signal)
    return { answer: town === opts.silent ? '' : own(town), steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = opts.steer === undefined ? undefined : new Promise<void>(resolve => { heard = resolve })
  if (opts.steer !== undefined) setTimeout(() => heard!(), opts.steer)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search] }
  const hire = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
  return { paths, hire, models, quick, searches, since: Date.now() }
}
const members = (towns: string[]) => towns.map(town => ({ role: `${town} 조사`, topic: town, brief: `${town} 이번 주말 서핑 파도 높이`, lookup: true }))
const SPLIT = '강릉 속초 양양 토요일 서핑 파도 견줘줘'

describe('stack-16: judge fields reach the writer (c16b → c16a)', () => {
  it('no judge stands between a helper and the lead: each helper\'s own sentence, with its value and its page, is what the lead is handed, under the note that shapes the one answer', async () => {
    const { hire, quick } = await lane('fields', '강릉 속초 이번 주말 파도 각각')
    const out = JSON.parse(await hire.run({ members: members(['강릉', '속초']) }, { task: '' })) as Handed
    expect(out.members.map(m => m.result)).toEqual([own('강릉'), own('속초')])
    expect(out.members.map(m => m.sources?.length)).toEqual([1, 1])
    expect(out.members.map(m => m.accepted)).toEqual([true, true])
    expect(out.note).toContain(MERGED_SHAPE)
    expect(quick).toEqual([])
    for (const gone of ['kindChecked', 'reportPrompt', 'mergedReport', 'latestName']) expect(gone in core, gone).toBe(false)
  })
})

describe('stack-16: missing on the team path (c16c inside c16a)', () => {
  it('a helper that writes nothing hands over the rows it read, with their page, beside the others\' own words; the host makes up no sentence, writes no table and asks no check', async () => {
    const { hire, quick, models } = await lane('missing', '강릉 속초 고성 파도 각각', { silent: '고성' })
    const out = JSON.parse(await hire.run({ members: members(['강릉', '속초', '고성']) }, { task: '' })) as Handed
    expect(out.members.slice(0, 2).map(m => m.result)).toEqual([own('강릉'), own('속초')])
    expect(out.members[2]!.result).toBe(`고성 이번 주말 파도 1m 안팎: 예보, 11월 20일 ${PAGE['고성']}`)
    expect(models.sort()).toEqual(['강릉', '고성', '속초'])
    expect(quick).toEqual([])
    expect('helperAnswer' in core).toBe(false)
  })
})

describe('stack-16: one clock, steer, stop and call counts on the anonymous split', () => {
  it('a 3-part split with slow searches and slow helpers hands over before 35 s with three model calls, three searches and no host round', async () => {
    const { hire, quick, models, searches, since } = await lane('clock', SPLIT, { searchMs: 400, modelMs: 900 })
    const text = await hire.run({ members: members(['강릉', '속초', '양양']) }, { task: '' })
    expect(Date.now() - since).toBeLessThan(35_000)
    for (const town of ['강릉', '속초', '양양']) { expect(text).toContain(own(town).slice(0, 12)); expect(text).toContain(PAGE[town]) }
    expect(hire.closesOn?.(text) ?? false).toBe(false)
    expect(searches).toHaveLength(3)
    expect(models).toHaveLength(3)
    expect(quick).toEqual([])
  }, 45_000)

  it('a part added mid-work is handed over with the first three, each in its own words; the first call says who still works and closes nothing', async () => {
    const { hire } = await lane('steer', SPLIT, { steer: 10, modelMs: 80 })
    const first = await hire.run({ members: members(['강릉', '속초', '양양']) }, { task: '' })
    expect((JSON.parse(first) as Handed).members.map(m => [m.state, m.result])).toEqual([['working', undefined], ['working', undefined], ['working', undefined]])
    expect((JSON.parse(first) as Handed).note).toContain('call hire_members now for that part only')
    expect(hire.closesOn?.(first) ?? false).toBe(false)
    const out = JSON.parse(await hire.run({ members: members(['고성']) }, { task: '' })) as Handed
    expect(out.members.map(m => m.result)).toEqual(['강릉', '속초', '양양', '고성'].map(own))
  })

  it.each([['a helper\'s search', { searchMs: 5000 }, 50], ['a helper\'s writing', { modelMs: 5000 }, 300]] as const)('"멈춰" during %s halts within 3 s and nothing is written after', async (_what, timing, stopAt) => {
    const { hire, quick, models } = await lane('stop', SPLIT, timing)
    const stop = new AbortController()
    setTimeout(() => stop.abort(), stopAt)
    const began = Date.now()
    const out = await hire.run({ members: members(['강릉', '속초', '양양']) }, { task: '', signal: stop.signal }).catch(() => '')
    expect(Date.now() - began - stopAt).toBeLessThan(3000)
    for (const town of ['강릉', '속초', '양양']) expect(out).not.toContain(own(town))
    const calls = models.length
    await tick(300)
    expect(models.length).toBe(calls)
    expect(quick).toEqual([])
  }, 15_000)

  it('the team summary writer stops at once on a stop, and what it had not finished is never posted', async () => {
    const paths = await vault('summary')
    for (const name of ['엔그램', '하람']) await createBot(paths, { name })
    const bots = await loadBots(paths), haram = bots.find(bot => bot.name === '하람')!
    await employeeWriteBack(paths, { botId: haram.id, brief: '양양 서핑 강습 요금 조사', result: '양양 서핑 강습은 5만 원부터예요.' })
    const ctl = new AbortController()
    let asked = 0
    setTimeout(() => ctl.abort(), 100)
    const began = Date.now()
    const out = await teamSummary(paths, { bots, message: '팀원들 작업 내역 알려줘', write: () => { asked++; return new Promise<string>(() => undefined) }, timeoutMs: 20_000, signal: ctl.signal })
    expect(Date.now() - began).toBeLessThan(1000)
    expect(asked).toBe(1)
    expect(out).toContain('하람')
    const whole = '하람이 양양 서핑 강습 요금을 알아봤어요.\n\n강습은 5만 원부터라고 해요.'
    expect(await teamSummary(paths, { bots, message: '팀원들 작업 내역 알려줘', write: async () => whole })).toBe(whole)
  })

  it('"멈춰" during a desk build ends the build at once and closes no turn: no reply is posted for a file that was not made', async () => {
    const stop = new AbortController()
    const build: AgentTool = { name: 'word_write', description: '', argsSchema: { type: 'object', properties: {}, required: [] }, run: (_args, context) => new Promise<string>((_resolve, reject) => context.signal!.addEventListener('abort', () => reject(new Error('stopped')))) }
    const [closing] = desk.closingBuilds([build])
    setTimeout(() => stop.abort(), 50)
    const began = Date.now()
    await expect(closing!.run({ title: '회고 메모', reply: '원인이랑 대책으로 나눠 워드로 만들었어요.', more: false }, { task: '', signal: stop.signal })).rejects.toThrow('stopped')
    expect(Date.now() - began).toBeLessThan(3000)
    expect(closing!.closesOn?.('')).toBe(false)
    expect('checkedDesk' in desk).toBe(false)
  })
})

describe('stack-16: the person reads only a helper\'s own words', () => {
  it('a helper stopped at its limit mid-sentence, with rows it read and a page that did not open: its own words are whole sentences, and the hand-back keeps both apart from the model\'s reply', async () => {
    const m: TeamMember = { id: 'h1', parentId: null, depth: 1, role: '여수 조사', topic: '여수', brief: '여수 밤바다 유람선 요금', lookup: true, state: 'working', sessionKey: 's', hiredAt: new Date().toISOString() }
    const answer = '여수 밤바다 유람선은 성인 2만 원이에요. [여수관광](https://yeosu.example/cruise) 주말엔 저녁 7시와 9시에 출항하고, 예약은 전화로'
    const read = '여수 유람선 후기 모음: 블로그 글, 2026.10.02 https://blog.example/yeosu\n여수 가볼 만한 곳 TOP 10: 여행 앱 https://app.example/yeosu'
    settleMember(m, { answer, timedOut: true, read, sources: ['https://yeosu.example/cruise', 'https://blog.example/yeosu'] }, new Date().toISOString(), true)
    expect(m.result).toContain('한도에서 멈춤')
    expect(m.said).toBe('여수 밤바다 유람선은 성인 2만 원이에요. [여수관광](https://yeosu.example/cruise)')
    await withLiveSources([m], async url => !url.includes('yeosu.example'))
    const handed = (JSON.parse(handBacks([m])) as { reports: { result: string }[] }).reports[0]!.result
    expect(handed).toBe(m.result)
    expect(handed).toContain('성인 2만 원')
    const draft = '여수 밤바다 유람선은 성인 2만 원이에요.'
    const shown = (await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }) } as never, workdir: '/x', tools: [] }, '여수 유람선 요금', {})).answer
    expect(shown).toBe(draft)
    for (const host of ['한도에서 멈춤', 'no live source', '후기 모음', 'TOP 10', '예약은 전화로']) expect(shown).not.toContain(host)
  })

  it('a helper that wrote nothing of its own before its limit hands back what it read, marked as read, with no sentence made up for it', () => {
    const m: TeamMember = { id: 'h2', parentId: null, depth: 1, role: '통영 조사', topic: '통영', brief: '통영 케이블카 요금', lookup: true, state: 'working', sessionKey: 's', hiredAt: new Date().toISOString() }
    settleMember(m, { answer: '', timedOut: true, read: '통영 케이블카 요금 안내: 공식, 2026.11.01 https://tongyeong.example/fare', sources: ['https://tongyeong.example/fare'] }, new Date().toISOString(), true)
    expect(m.read).toBe(true)
    expect(m.said ?? '').toBe('')
    expect(m.result).toBe('통영 케이블카 요금 안내: 공식, 2026.11.01 https://tongyeong.example/fare\n(시간 한도에서 멈춤: 여기까지 찾은 내용)')
    expect((JSON.parse(handBacks([m])) as { reports: { result: string; sources?: string[] }[] }).reports[0]).toMatchObject({ result: m.result, sources: ['https://tongyeong.example/fare'] })
    expect('helperParts' in core).toBe(false)
  })
})

describe('stack-16: a listing page taken apart keeps the person\'s language', () => {
  it('no items round is left; the reply rule itself asks for the person\'s language whatever the page\'s (an English conference page, a Korean thread)', () => {
    expect('itemsPrompt' in core).toBe(false)
    expect(WORK_REPLY_RULE).toContain('in the language the person wrote in')
  })
})
