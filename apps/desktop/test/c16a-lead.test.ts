import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTask, helperAnswer, kindChecked, listTasks, mergedReport, mergingHire, reportData, REPORT_WRITER_MS, setReportLog, settleMember, updateTask, writtenReport, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'

// c16a (cause M: the helpers' answer had a second writer, the lead model, with no form guarantee and no time for its check; cause F2: the
// team writer worked to a fixed 8 s and its fallback read like a report). Wordings are not the harness's: 도쿄/오사카/후쿠오카 환율 영향,
// 오키나와, 갤럭시 탭/아이패드/서피스 가격, 부산 불꽃축제, 피그마/미로/캔바 (c15b r3 #1's repro), teammates 하람 / 이든.
type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-c16a-${tag}-`)), '.engram') } as unknown as VaultPaths }
const CHECK = 'Judge meaning only'
const none = JSON.stringify({ problems: [] })
const PAGE: Record<string, string> = { 도쿄: 'https://fx.example.jp/tokyo', 오사카: 'https://fx.example.jp/osaka', 후쿠오카: 'https://fx.example.jp/fukuoka', 오키나와: 'https://fx.example.jp/okinawa' }
const tableRows = (text: string): string[] => text.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line) && !/^[\s|:-]+$/.test(line)).slice(1)
afterEach(() => { vi.useRealTimers(); setReportLog(() => undefined) })

/** A quick model that writes the one table the writer is asked for, from the data it is given (one row per part, its fact and link). */
const tableWriter = (calls: string[], prose = false) => async (prompt: string): Promise<string> => {
  calls.push(prompt)
  if (prompt.includes(CHECK)) return none
  const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts?: { id: string; text: string; link: string }[] }[]
  const rows = data.filter(p => p.facts?.length).map(p => ({ part: p.part, fact: p.facts![0]! }))
  const message = prose ? rows.map(r => `${r.part}: ${r.fact.text} ${r.fact.link}`).join('\n')
    : ['엔화 약세로 세 도시 모두 여행 경비 부담이 줄었어요.', '', '| 도시 | 환율 영향 | 출처 |', '|---|---|---|', ...rows.map(r => `| ${r.part} | ${r.fact.text} | ${r.fact.link} |`)].join('\n')
  return JSON.stringify({ message, kept: rows.map(r => r.fact.id) })
}

async function lane(tag: string, ask: string, opts: { steer?: number; delay?: number; prose?: boolean } = {}) {
  const paths = await vault(tag)
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const models: string[] = [], quick: string[] = [], prompts: string[] = []
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.(); models.push(prompt.slice(0, 20)); prompts.push(`${options.persona ?? ''}\n${prompt}`)
    const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', city = Object.keys(PAGE).find(name => part.includes(name)) ?? '도쿄'
    await new Promise(resolve => setTimeout(resolve, opts.delay ?? 0))
    return { answer: `${city}은 엔화 약세로 원화 환산 경비가 작년보다 10% 줄었어요. [${city} 환율 소식](${PAGE[city]})`, steps: [], fellBack: false }
  }
  const write = tableWriter(quick, opts.prose)
  const engine = { id: 'claude', quick: async (prompt: string) => write(prompt) } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = opts.steer === undefined ? undefined : new Promise<void>(resolve => { heard = resolve })
  if (opts.steer !== undefined) setTimeout(() => heard!(), opts.steer)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => team.tools(one, kit), alive: async () => true }
  const since = Date.now()
  // The lane's wiring (ipc.ts): hire_members wrapped so its hand-back of accepted lookups is the team writer's answer.
  const hire: AgentTool = mergingHire(team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!, async signal => helperAnswer({ ask, members: (await listTasks(paths)).find(t => t.state === 'running')?.team?.members, since, write: (prompt: string) => write(prompt), due: since + 28_000, signal }))
  return { paths, hire, models, quick, prompts }
}

describe('c16a: one writer for the helpers\' answer (cause M)', () => {
  it('an anonymous three-way split is written by the team writer: one table, three rows, a link on each; the call closes the turn', async () => {
    const { hire, models, quick } = await lane('split', '도쿄 오사카 후쿠오카 환율 영향 각각 알아봐서 정리해줘')
    const out = await hire.run({ members: ['도쿄', '오사카', '후쿠오카'].map(city => ({ role: `${city} 조사`, topic: city, brief: `${city} 여행 경비에 엔화 환율이 주는 영향`, lookup: true })) }, { task: '' })
    const rows = tableRows(out)
    expect(rows).toHaveLength(3)
    for (const [i, city] of ['도쿄', '오사카', '후쿠오카'].entries()) { expect(rows[i]).toContain(city); expect(rows[i]).toContain(`](${PAGE[city]})`) }
    // No helper's role ("도쿄 조사") and no name: the person named nobody.
    expect(out).not.toContain('조사')
    // The turn ends on this reply: the lead model writes no second answer turn.
    expect(hire.closes).toBe(true)
    expect(hire.closesOn!(out)).toBe(true)
    // Model calls: the three helpers only; quick calls: the writer and its meaning check (with the ask's own constraints).
    expect(models).toHaveLength(3)
    expect(quick).toHaveLength(2)
    expect(quick[1]).toContain('"dropped": the person\'s ask says how the work is to be done')
  })

  it('a writer that gives prose twice (no table) leaves the host\'s table: three rows, each linked', async () => {
    const { hire, quick } = await lane('prose', '도쿄 오사카 후쿠오카 환율 영향 각각 알아봐서 정리해줘', { prose: true })
    const out = await hire.run({ members: ['도쿄', '오사카', '후쿠오카'].map(city => ({ role: city, topic: city, brief: `${city} 환율 영향`, lookup: true })) }, { task: '' })
    // The writer, then its repair (the "table" rule): both prose, so the host's rendering.
    expect(quick).toHaveLength(2)
    expect(quick[1]).toContain('one markdown table with one row per part')
    const rows = tableRows(out)
    expect(rows).toHaveLength(3)
    for (const [i, city] of ['도쿄', '오사카', '후쿠오카'].entries()) { expect(rows[i]!.startsWith(`| ${city} |`)).toBe(true); expect(rows[i]).toContain(PAGE[city]) }
    expect(hire.closesOn!(out)).toBe(true)
  })

  it('a part added mid-work ("오키나와도 넣어") is a row of the same one table', async () => {
    const { hire } = await lane('steer', '도쿄 오사카 후쿠오카 환율 영향 각각 알아봐서 정리해줘', { steer: 10, delay: 80 })
    const first = await hire.run({ members: ['도쿄', '오사카', '후쿠오카'].map(city => ({ role: city, topic: city, brief: `${city} 환율 영향`, lookup: true })) }, { task: '' })
    // The steer comes back to the lead to act on: no answer yet, the turn goes on.
    expect(hire.closesOn!(first)).toBe(false)
    expect(JSON.parse(first).note).toContain('call hire_members now for that part only')
    const out = await hire.run({ members: [{ role: '오키나와', topic: '오키나와', brief: '오키나와 환율 영향', lookup: true }] }, { task: '' })
    const rows = tableRows(out)
    expect(rows.map(row => row.split('|')[1]!.trim())).toEqual(['도쿄', '오사카', '후쿠오카', '오키나와'])
    expect(hire.closesOn!(out)).toBe(true)
  })

  it('a split comparison carries one measure to every part and to the writer (the cell label rule is the writer\'s)', async () => {
    const { hire, prompts, quick } = await lane('measure', '갤럭시 탭, 아이패드, 서피스 가격 비교 따로 조사시켜')
    const measure = '가격: 와이파이 기본 모델 최저 용량의 국내 출시가, 원 단위'
    await hire.run({ measure, members: ['갤럭시 탭', '아이패드', '서피스'].map(name => ({ role: name, topic: name, brief: `${name} 가격`, lookup: true })) }, { task: '' })
    // Every part's brief holds the same definition.
    expect(prompts).toHaveLength(3)
    for (const prompt of prompts) expect(prompt).toContain(`the same for every part: ${measure}`)
    // The writer reads it, and is told a value on another basis is labeled in its cell.
    expect(quick[0]).toContain(`"measure":"${measure}"`)
    expect(quick[0]).toContain('a value on another basis (another model or tier, unit or day) is labeled in its cell')
  })

  it('"멈춰" while the writer runs: the call ends at once and nothing is written after', async () => {
    const paths = await vault('stop')
    const ctl = new AbortController(), calls: string[] = []
    const helpers: TeamMember[] = ['도쿄', '오사카'].map((city, i) => ({ id: `m${i + 1}`, parentId: null, depth: 1, role: city, topic: city, brief: `${city} 환율 영향`, lookup: true, state: 'released', review: { ok: true, note: 'auto: sourced lookup' }, sessionKey: `s${i}`, hiredAt: new Date().toISOString(), result: `${city}은 경비가 줄었어요. [소식](${PAGE[city]})`, sources: [PAGE[city]!] }))
    void paths
    setTimeout(() => ctl.abort(), 30)
    const at = Date.now()
    const out = await helperAnswer({ ask: '도쿄 오사카 환율 영향', members: helpers, since: at - 5000, write: async prompt => { calls.push(prompt); return new Promise<string>(() => undefined) }, due: at + 20_000, signal: ctl.signal })
    expect(Date.now() - at).toBeLessThan(500)
    expect(calls).toHaveLength(1)
    // What comes back is the host's table; mergingHire drops it on a stop, and the session posts nothing after one.
    expect(tableRows(out!)).toHaveLength(2)
    const hire = mergingHire({ name: 'hire_members', description: '', argsSchema: {}, run: async () => JSON.stringify({ members: [{ accepted: true }], note: 'Members with accepted true are lookups' }) }, async () => { ctl.abort(); return 'written' })
    const stopped = await hire.run({}, { task: '', signal: ctl.signal })
    expect(stopped).not.toBe('written')
    expect(hire.closesOn!(stopped)).toBe(false)
  })

  it('a helper that asks the person or made a file leaves the answer to the lead (no writer)', async () => {
    const at = Date.now(), base = { parentId: null, depth: 1, state: 'released' as const, sessionKey: 's', hiredAt: new Date(at).toISOString(), review: { ok: true, note: 'auto: sourced lookup' } }
    const lookups: TeamMember[] = [{ ...base, id: 'm1', role: '도쿄', brief: '도쿄', lookup: true, result: '도쿄 [a](https://a.example)' }, { ...base, id: 'm2', role: '표', brief: '표 만들기', result: '만들었어요', files: ['표.xlsx'] }]
    expect(await helperAnswer({ ask: '도쿄', members: lookups, since: at, write: async () => 'x', due: at + 10_000 })).toBeUndefined()
  })
})

describe('c16a: the writer works to the answer\'s due (cause F2)', () => {
  const T0 = Date.parse('2026-11-19T01:00:00Z')
  const handed = (): TeamMember => {
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '하람', brief: '이번 주말 강릉 날씨 찾기', topic: '강릉 날씨', botId: 'bot-m1', lookup: true, state: 'done', sessionKey: 's1', hiredAt: new Date(T0 - 20_000).toISOString() }
    const answer = `\`\`\`report\n${JSON.stringify({ facts: [{ text: '토요일 강릉은 맑고 낮 12도예요.', url: 'https://weather.example.kr/gangneung', date: '11월 21일' }] })}\n\`\`\``
    settleMember(m, { answer, report: reportData(answer, m, [], true) ?? null }, new Date(T0 - 1000).toISOString(), true)
    return m
  }
  const good = JSON.stringify({ message: '토요일 강릉은 맑아요. 하람이 봤는데 낮 12도예요. [기상](https://weather.example.kr/gangneung)', kept: ['f1'] })
  const nameless = JSON.stringify({ message: '토요일 강릉은 맑고 낮 12도예요. [기상](https://weather.example.kr/gangneung)', kept: ['f1'] })
  // The first draft leaves 하람 unnamed (a shape problem); its repair takes 10 s; the check answers at once.
  const slowRepair = (calls: string[]) => (prompt: string): Promise<string> => { calls.push(prompt); return prompt.includes(CHECK) ? Promise.resolve(none) : calls.filter(one => !one.includes(CHECK)).length === 1 ? Promise.resolve(nameless) : new Promise(resolve => setTimeout(() => resolve(good), 10_000)) }

  it('a hand-off due 45 s after the message, 17 s left: a repair that needs 10 s lands', async () => {
    vi.useFakeTimers({ now: T0 })
    const calls: string[] = [], m = handed()
    const out = writtenReport({ ask: '하람이는 이번 주말 강릉 날씨 찾아봐', members: [m], write: slowRepair(calls), due: T0 + 17_000 })
    await vi.advanceTimersByTimeAsync(12_000)
    expect(await out).toContain('하람이 봤는데')
    expect(calls).toHaveLength(3)
  })

  it('with 3 s left the host\'s rendering is shown, inside the writer\'s least time, and no repair runs past it', async () => {
    vi.useFakeTimers({ now: T0 })
    const calls: string[] = [], m = handed()
    const out = writtenReport({ ask: '하람이는 이번 주말 강릉 날씨 찾아봐', members: [m], write: slowRepair(calls), due: T0 + 3000 })
    await vi.advanceTimersByTimeAsync(REPORT_WRITER_MS + 100)
    expect(await out).toBe(mergedReport([m]))
    expect(Date.now() - T0).toBeLessThanOrEqual(REPORT_WRITER_MS + 100)
    expect(calls).toHaveLength(2)
  })
})

describe('c16a: the fallback reads like one person (cause F2, c15b r3 #1)', () => {
  const GU = 'https://www.suyeong.go.kr/fireworks', BLOG = 'https://blog.naver.com/someone/123', TICKET = 'https://www.suyeong.go.kr/seats'
  it('one part, a fact found twice: one row, the first-hand link, and no other day beside a text that states its own', async () => {
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '이든', brief: '부산 불꽃축제 날짜 찾기', topic: '부산 불꽃축제', botId: 'bot-m1', lookup: true, state: 'done', sessionKey: 's1', hiredAt: new Date().toISOString() }
    const facts = [
      { text: '부산 불꽃축제는 11월 15일 광안리에서 열린대요.', url: BLOG, site: '네이버 블로그', date: '11월 2일' },
      { text: '부산 불꽃축제는 11월 15일 토요일 저녁 7시 광안리 해수욕장에서 열려요.', url: GU, site: '수영구청', date: '10월 30일' },
      { text: '유료 관람석 예매는 11월 3일부터 받아요.', url: TICKET, site: '수영구청', date: '10월 28일' },
    ]
    // The item judge: all three are the kind asked; 1 and 2 are one fact, 1 passes it on second-hand.
    const judge = async () => JSON.stringify({ keep: [1, 2, 3], unsure: [], same: [[1, 2]], lists: [], names: {}, listing: [], outside: [], secondhand: [1] })
    m.data = await kindChecked({ facts }, m.brief, judge)
    const out = mergedReport([m])
    expect(out).toContain(GU)
    expect(out).not.toContain(BLOG)
    expect(out).not.toMatch(/\((?:11월 2일|10월 30일|10월 28일)\)/)
    // Whose it is is said once (rule 7), on the first row only.
    expect(out.match(/\(이든\)/g)).toHaveLength(1)
    expect(out.split('\n').filter(line => line.startsWith('- '))).toHaveLength(2)
  })

  it('a fact with no day in its text keeps its date; one with a day of its own shows no other', () => {
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '이든', brief: '판교 개발자 밋업 찾기', botId: 'bot-m1', lookup: true, state: 'done', sessionKey: 's1', hiredAt: new Date().toISOString(),
      data: { facts: [{ text: '판교 리액트 밋업이 열려요.', url: 'https://meetup.example.kr/react', site: '밋업', date: '12월 9일' }, { text: '판교 개발자 모임이 12월 16일 저녁에 열려요.', url: 'https://meetup.example.kr/notice', site: '밋업', date: '11월 30일' }] } }
    const out = mergedReport([m])
    expect(out).toContain('판교 리액트 밋업이 열려요 (12월 9일).')
    expect(out).not.toContain('11월 30일')
  })

  it('c15b r3 #1: three parts with nothing new say that state once; each row is the latest thing\'s short name', () => {
    const quiet = ['피그마', '미로', '캔바'].map((topic, i) => {
      const m: TeamMember = { id: String(i), parentId: null, depth: 1, role: ['하은', '준', '소윤'][i]!, brief: `${topic} 새 기능`, topic, botId: `b${i}`, lookup: true, state: 'done', sessionKey: `s${i}`, hiredAt: new Date().toISOString() }
      const answer = `\`\`\`report\n${JSON.stringify({ facts: [], nothing_in_period: { latest: { text: `${topic}는 이번 주 새 기능이 없고, 최근에는 개선판이 나왔어요.`, name: `${topic} 개선판`, url: `https://example.com/${i}`, site: '예시', date: '11월 5일' } } })}\n\`\`\``
      settleMember(m, { answer, report: reportData(answer, m, [], true) ?? null }, new Date().toISOString(), true)
      return m
    })
    const out = mergedReport(quiet)
    expect(out.match(/없/g)).toHaveLength(1)
    for (const topic of ['피그마', '미로', '캔바']) expect(out).toContain(`${topic} 개선판 (11월 5일)`)
  })
})
