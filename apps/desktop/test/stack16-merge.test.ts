import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, itemsPrompt, helperAnswer, helperParts, settleMember, withLiveSources, kindChecked, listTasks, mergedReport, mergingHire, reportPrompt, setReportLog, updateTask, writtenReport, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
import { checkedDesk } from '../src/main/desk-lane.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { agreeing } from '../../../packages/core/test/agreeing.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-s16-${tag}-`)), '.engram') } as unknown as VaultPaths }
const CHECK = 'Judge meaning only', JUDGE = 'In "holds", for each item'
const none = JSON.stringify({ problems: [] })
const PAGE: Record<string, string> = { 강릉: 'https://surf.example/gangneung', 속초: 'https://surf.example/sokcho', 양양: 'https://surf.example/yangyang', 고성: 'https://surf.example/goseong' }
const tableRows = (text: string): string[] => text.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line) && !/^[\s|:-]+$/.test(line)).slice(1)
const results = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
afterEach(() => { vi.useRealTimers(); setReportLog(() => undefined) })
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function quickModel(log: { kind: string; at: number; prompt: string }[], opts: { judgeMs?: number; writeMs?: number; checkMs?: number; prose?: number; missing?: number } = {}) {
  let prose = opts.prose ?? 0, missing = opts.missing ?? 0
  return async (prompt: string): Promise<string> => {
    if (prompt.includes(JUDGE)) {
      log.push({ kind: 'judge', at: Date.now(), prompt }); await tick(opts.judgeMs ?? 0)
      const held = /Items 1 to (\d+) were already judged/.exec(prompt)
      return held ? JSON.stringify({ keep: [Number(held[1]) + 1], holds: { [Number(held[1]) + 1]: { '파도 높이': '파도 0.8~1.2m' } }, asked: 1, search: '' }) : JSON.stringify({ keep: [1, 2], holds: {}, points: ['파도 높이'], asked: 1, search: '파도 높이 예보', open: 2 })
    }
    if (prompt.includes(CHECK)) {
      log.push({ kind: 'check', at: Date.now(), prompt }); await tick(opts.checkMs ?? 0)
      return missing-- > 0 ? JSON.stringify({ problems: [{ kind: 'missing', quote: '고성', why: '고성 행이 없어요' }] }) : none
    }
    log.push({ kind: 'write', at: Date.now(), prompt }); await tick(opts.writeMs ?? 0)
    const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { id: string; text: string; link: string }[] }[]
    const rows = data.filter(p => p.facts?.length).map(p => ({ part: p.part, fact: p.facts![0]! }))
    const message = prose-- > 0 ? rows.map(r => `${r.part}는 ${r.fact.text}`).join(' ')
      : ['세 곳 모두 이번 주말 파도가 서핑하기 괜찮아요.', '', '| 해변 | 파도 | 출처 |', '|---|---|---|', ...rows.map(r => `| ${r.part} | ${r.fact.text} | ${r.fact.link} |`)].join('\n')
    return JSON.stringify({ message, kept: rows.map(r => r.fact.id) })
  }
}

async function lane(tag: string, ask: string, opts: Parameters<typeof quickModel>[1] & { searchMs?: number; modelMs?: number; steer?: number; stopAt?: number; answerMs?: number } = {}) {
  const paths = await vault(tag)
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const models: string[] = [], quick: { kind: string; at: number; prompt: string }[] = [], searches: string[] = []
  const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
    const q = String(args['query']); searches.push(q); await tick(opts.searchMs ?? 0)
    const town = Object.keys(PAGE).find(name => q.includes(name)) ?? '강릉'
    return q.includes('예보') ? results(q, [`- ${town} 파도 예보 — ${PAGE[town]}/forecast — 파도 0.8~1.2m, 서핑 적기 — 11월 21일`]) : results(q, [`- ${town} 해변 서핑 숍 소개 — https://blog.example/${encodeURIComponent(town)} — 블로그 — 11월 2일`, `- ${town} 이번 주말 파도 1m 안팎 — ${PAGE[town]} — 예보 — 11월 20일`])
  } }
  const run: Run = async (deps, prompt, options = {}) => {
    options.onStart?.(); models.push(prompt.slice(0, 20))
    const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', town = Object.keys(PAGE).find(name => part.includes(name)) ?? '강릉'
    const tool = deps.tools?.find(t => t.name === 'search_web')
    if (tool) { await tool.run({ query: `${town} 서핑 파도` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) }) }
    await tick(opts.modelMs ?? 0)
    if (options.signal?.aborted) throw new Error('aborted')
    return { answer: `${town}은 이번 주말 파도가 1m 안팎이에요. [${town} 파도 예보](${PAGE[town]})`, steps: [], fellBack: false }
  }
  const write = agreeing(quickModel(quick, opts))
  const engine = { id: 'claude', quick: async (prompt: string) => write(prompt) } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = opts.steer === undefined ? undefined : new Promise<void>(resolve => { heard = resolve })
  if (opts.steer !== undefined) setTimeout(() => heard!(), opts.steer)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(opts.answerMs ? { answerMs: opts.answerMs } : {}), ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), search], alive: async () => true }
  const since = Date.now(), stop = new AbortController()
  if (opts.stopAt !== undefined) setTimeout(() => stop.abort(), opts.stopAt)
  const hire: AgentTool = mergingHire(team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!, async signal => helperAnswer({ ask, members: (await listTasks(paths)).find(t => t.state === 'running')?.team?.members, since, write: agreeing((prompt: string) => write(prompt)), due: since + (opts.answerMs ?? 28_000), signal: signal ?? stop.signal }))
  return { paths, hire, models, quick, searches, since, stop }
}
const members = (towns: string[]) => towns.map(town => ({ role: `${town} 조사`, topic: town, brief: `${town} 이번 주말 서핑 파도 높이`, lookup: true }))

describe('stack-16: judge fields reach the writer (c16b → c16a)', () => {
  it('a fact the judge says holds the value leads the writer data and the host fallback; a nothing part with no short name uses latestName', async () => {
    const facts = [{ text: '대구는 미세먼지 이야기가 많아요.', url: 'https://blog.example/daegu', site: '블로그' }, { text: '대구 오늘 미세먼지는 보통(42㎍/㎥)이에요.', url: 'https://air.example/daegu', site: '에어코리아' }]
    const judged = await kindChecked({ facts }, '대구 오늘 미세먼지 농도', agreeing(async () => JSON.stringify({ keep: [1, 2], holds: { 2: { 농도: '보통(42㎍/㎥)' } }, points: ['농도'], asked: 1 })))
    // c19a (cause H): the judge's holds no longer reorder a teammate's facts; they keep the teammate's own order.
    expect(judged!.facts.map(f => f.url)).toEqual(['https://blog.example/daegu', 'https://air.example/daegu'])
    const at = new Date().toISOString()
    const m = (id: string, role: string, data: TeamMember['data']): TeamMember => ({ id, parentId: null, depth: 1, role, topic: role, brief: `${role} 조사`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: id, hiredAt: at, result: 'x', data })
    const parts = [m('m1', '대구', judged), m('m2', '판교', { facts: [], nothing: { latest: { text: '판교 카페 거리 새 매장 오픈 소식, 영업시간은 10시부터 22시까지, 주말 포함', url: 'https://cafe.example/pangyo', site: '카페' } } })]
    const prompt = reportPrompt('대구 미세먼지랑 판교 카페 소식', parts, new Map(), { helpers: true })
    const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { facts?: { link: string }[]; nothing?: { latest: { text: string } } }[]
    expect(data[0]!.facts!.map(f => f.link).join(' ')).toContain('air.example')
    expect(data[1]!.nothing!.latest.text).toContain('판교 카페 거리 새 매장 오픈 소식')
    expect(data[1]!.nothing!.latest.text).not.toContain('영업시간')
    const fallback = mergedReport(parts, new Map(), [], true)
    expect(fallback).toContain('air.example')
    expect(fallback).toContain('blog.example')
  })
})

describe('stack-16: missing on the team path (c16c inside c16a)', () => {
  it('the helpers\' one check carries the missing line; a draft refused for missing twice falls back to the host table with every part a row', async () => {
    const log: { kind: string; at: number; prompt: string }[] = []
    const at = new Date().toISOString()
    const helpers: TeamMember[] = ['강릉', '속초', '고성'].map((town, i) => ({ id: `m${i}`, parentId: null, depth: 1, role: town, topic: town, brief: `${town} 파도`, lookup: true, state: 'released', review: { ok: true, note: 'auto: sourced lookup' }, sessionKey: `s${i}`, hiredAt: at, result: `${town}은 파도 1m예요. [예보](${PAGE[town]})`, sources: [PAGE[town]!] }))
    const out = await helperAnswer({ ask: '강릉 속초 고성 파도 각각', members: helpers, since: Date.now() - 1000, write: agreeing(quickModel(log, { missing: 2 })), due: Date.now() + 20_000 })
    expect(log.map(l => l.kind)).toEqual(['write', 'check', 'write'])
    expect(log[2]!.prompt).toContain('You fix a message')
    expect(log[1]!.prompt).toContain('"missing": the person\'s ask names parts')
    const rows = tableRows(out)
    expect(rows.map(row => row.split('|')[1]!.trim())).toEqual(['강릉', '속초', '고성'])
    for (const town of ['강릉', '속초', '고성']) expect(out).toContain(PAGE[town])
  })
})

describe('stack-16: one clock, steer, stop and call counts on the anonymous split', () => {
  it('helper search rounds (held rows) + deadline writer + one repair answer a 3-part split before 35 s (real clock: the item judge\'s round sizes are real-time constants)', async () => {
    const { hire, quick, models, searches, since } = await lane('clock', '강릉 속초 양양 이번 주말 서핑 파도 비교해줘', { searchMs: 2500, judgeMs: 2500, modelMs: 6000, writeMs: 3000, checkMs: 2500, prose: 1 })
    const text = await hire.run({ members: members(['강릉', '속초', '양양']) }, { task: '' })
    expect(Date.now() - since).toBeLessThan(35_000)
    expect(tableRows(text)).toHaveLength(0)
    for (const town of ['강릉', '속초', '양양']) expect(text).toContain(town)
    expect(hire.closesOn!(text)).toBe(true)
    // c19a: no judge proposes a second search for an uncounted part: the helper answers from its first search's rows.
    expect(searches.filter(q => q.includes('예보'))).toHaveLength(0)
    // c19a: an uncounted part runs no judge round before or after its reader.
    expect(quick.filter(l => l.kind === 'judge')).toHaveLength(0)
    expect(models).toHaveLength(3)
    // c19a: the prose draft links no part, so the one scoped repair is asked for them (a second 'write'); when it does not land the host
    // adds each part's own line with its link after the draft, never a template over it.
    expect(quick.filter(l => l.kind !== 'judge').map(l => l.kind)).toEqual(['write', 'check', 'write'])
    for (const town of ['강릉', '속초', '양양']) expect(text).toContain(PAGE[town])
  }, 45_000)

  it('a part added mid-work lands as a row of the one table; one answer after the first, non-closing call', async () => {
    const { hire } = await lane('steer', '강릉 속초 양양 이번 주말 서핑 파도 비교해줘', { steer: 10, modelMs: 80 })
    const first = await hire.run({ members: members(['강릉', '속초', '양양']) }, { task: '' })
    expect(hire.closesOn!(first)).toBe(false)
    const out = await hire.run({ members: members(['고성']) }, { task: '' })
    expect(tableRows(out).map(row => row.split('|')[1]!.trim())).toEqual(['강릉', '속초', '양양', '고성'])
    expect(hire.closesOn!(out)).toBe(true)
  })

  it.each([['a judge round', { judgeMs: 5000 }, 50], ['a writer repair', { writeMs: 5000, missing: 1 }, 5300]] as const)('"멈춰" during %s halts within 3 s and nothing is written after', async (_what, timing, stopAt) => {
    const { hire, quick, stop } = await lane('stop', '강릉 속초 양양 이번 주말 서핑 파도 비교해줘', { ...timing, stopAt })
    const began = Date.now()
    const out = await hire.run({ members: members(['강릉', '속초', '양양']) }, { task: '', signal: stop.signal })
    expect(Date.now() - began - stopAt).toBeLessThan(3000)
    // c19a: with no judge round left, the split is answered before a stop at 50 ms; a stop during the writer's repair still ends it unsent.
    expect(hire.closesOn!(out)).toBe(_what === 'a judge round')
    const calls = quick.length
    await tick(300)
    expect(quick.length).toBe(calls)
  }, 15_000)

  it('writtenReport stops at once on a stop during its check (desk/written check shares the abort)', async () => {
    const ctl = new AbortController(), at = new Date().toISOString(), log: { kind: string; at: number; prompt: string }[] = []
    const parts: TeamMember[] = ['강릉', '속초'].map((town, i) => ({ id: `m${i}`, parentId: null, depth: 1, role: town, topic: town, brief: `${town} 파도`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: `s${i}`, hiredAt: at, result: 'x', data: { facts: [{ text: `${town} 파도 1m예요.`, url: PAGE[town]!, site: '서핑 예보' }] } }))
    setTimeout(() => ctl.abort(), 100)
    const began = Date.now()
    await writtenReport({ ask: '강릉 속초 파도', members: parts, helpers: true, write: agreeing(quickModel(log, { checkMs: 10_000 })), due: Date.now() + 20_000, signal: ctl.signal })
    expect(Date.now() - began).toBeLessThan(1000)
  })

  it('"멈춰" during a desk rewrite (a missing part being added) ends the check at once', async () => {
    const stop = new AbortController(), calls: string[] = []
    const quick = async (prompt: string): Promise<string | undefined> => {
      calls.push(prompt)
      if (calls.length === 1) return JSON.stringify({ problems: [{ kind: 'missing', quote: '대책', why: '대책이 없어요' }] })
      setTimeout(() => stop.abort(), 50)
      return new Promise<string | undefined>(() => undefined)
    }
    const began = Date.now()
    await checkedDesk({ ask: '장애 회고 메모 원인이랑 대책으로 나눠줘', draft: '원인: 배포 스크립트의 환경 변수 누락', source: '# 회고\n- 원인: 환경 변수 누락\n- 대책: 배포 전 점검 목록', fromSource: true, quick, since: Date.now(), signal: stop.signal })
    expect(Date.now() - began).toBeLessThan(3000)
    expect(calls).toHaveLength(2)
  })
})

describe('stack-16: the person reads only a helper\'s own words', () => {
  it('a helper stopped at its limit mid-sentence, with rows it read and a page that did not open: its row has its whole sentences only', async () => {
    const m: TeamMember = { id: 'h1', parentId: null, depth: 1, role: '여수 조사', topic: '여수', brief: '여수 밤바다 유람선 요금', lookup: true, state: 'working', sessionKey: 's', hiredAt: new Date().toISOString() }
    const answer = '여수 밤바다 유람선은 성인 2만 원이에요. [여수관광](https://yeosu.example/cruise) 주말엔 저녁 7시와 9시에 출항하고, 예약은 전화로'
    const read = '여수 유람선 후기 모음: 블로그 글, 2026.10.02 https://blog.example/yeosu\n여수 가볼 만한 곳 TOP 10: 여행 앱 https://app.example/yeosu'
    settleMember(m, { answer, timedOut: true, read, sources: ['https://yeosu.example/cruise', 'https://blog.example/yeosu'] }, new Date().toISOString(), true)
    expect(m.result).toContain('한도에서 멈춤')
    await withLiveSources([m], async url => !url.includes('yeosu.example'))
    const [part] = helperParts([{ ...m, state: 'released', review: { ok: true, note: 'auto' } }])
    const text = JSON.stringify(part!.data ?? {})
    expect(text).toContain('성인 2만 원')
    expect(text).toContain('(미확인)')
    for (const host of ['한도에서 멈춤', 'no live source', '후기 모음', 'TOP 10', '예약은 전화로']) expect(text).not.toContain(host)
    const table = mergedReport([part!], new Map(), [], true)
    for (const host of ['한도에서 멈춤', 'no live source', '후기 모음', '예약은 전화로']) expect(table).not.toContain(host)
  })

  it('a helper that wrote nothing of its own before its limit keeps its row, said plainly, with no raw rows', () => {
    const m: TeamMember = { id: 'h2', parentId: null, depth: 1, role: '통영 조사', topic: '통영', brief: '통영 케이블카 요금', lookup: true, state: 'working', sessionKey: 's', hiredAt: new Date().toISOString() }
    settleMember(m, { answer: '', timedOut: true, read: '통영 케이블카 요금 안내: 공식, 2026.11.01 https://tongyeong.example/fare', sources: ['https://tongyeong.example/fare'] }, new Date().toISOString(), true)
    const table = mergedReport(helperParts([{ ...m, state: 'released', review: { ok: true, note: 'auto' } }]), new Map(), [], true)
    expect(tableRows(table)).toHaveLength(0)
    expect(table).toMatch(/^통영은 /m)
    expect(table).not.toContain('요금 안내')
    expect(table).not.toContain('한도')
  })
})

describe('stack-16: a listing page taken apart keeps the person\'s language', () => {
  it('the items round restates the report\'s language rule (an English conference page, a Korean thread)', () => {
    expect(itemsPrompt(['https://conf.example/schedule'])).toContain('in the person\'s language whatever language the page is in')
  })
})

