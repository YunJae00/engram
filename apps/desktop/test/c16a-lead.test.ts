import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as core from 'core'
import { createBot, createTask, employeeNote, employeesAnswer, handBacks, listTasks, memberPersona, partOutcome, settleMember, TAKEN_OFF, updateTask, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'

type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
type Hired = { members: { id: string; role: string; state: string; accepted?: boolean; result?: string; sources?: string[] }[]; note: string }
type Back = { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
const vault = async (tag: string): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, `engram-c16a-${tag}-`)), '.engram') } as unknown as VaultPaths }
const PAGE: Record<string, string> = { 도쿄: 'https://fx.example.jp/tokyo', 오사카: 'https://fx.example.jp/osaka', 후쿠오카: 'https://fx.example.jp/fukuoka', 오키나와: 'https://fx.example.jp/okinawa' }
const SAID = (city: string): string => `${city}은 엔화 약세로 원화 환산 경비가 작년보다 10% 줄었어요. [${city} 환율 소식](${PAGE[city]})`
const three = (role = (city: string): string => city) => ['도쿄', '오사카', '후쿠오카'].map(city => ({ role: role(city), topic: city, brief: `${city} 환율 영향`, lookup: true }))
afterEach(() => { vi.useRealTimers() })

async function lane(tag: string, ask: string, opts: { steer?: number; delay?: number; hang?: boolean } = {}) {
  const paths = await vault(tag)
  const created = await createTask(paths, ask, 'b1')
  await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1 })
  const models: string[] = [], quick: string[] = [], prompts: string[] = [], signals = new Map<string, AbortSignal>()
  const run: Run = async (_deps, prompt, options = {}) => {
    options.onStart?.(); models.push(prompt.slice(0, 20)); prompts.push(`${options.persona ?? ''}\n${prompt}`)
    const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', city = Object.keys(PAGE).find(name => part.includes(name)) ?? '도쿄'
    if (options.signal) signals.set(city, options.signal)
    if (opts.hang) await new Promise((_, reject) => options.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
    await new Promise(resolve => setTimeout(resolve, opts.delay ?? 0))
    return { answer: SAID(city), steps: [], fellBack: false }
  }
  const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return '' } } as unknown as TurnKit['engine']
  let heard: (() => void) | undefined
  const said = opts.steer === undefined ? undefined : new Promise<void>(resolve => { heard = resolve })
  if (opts.steer !== undefined) setTimeout(() => heard!(), opts.steer)
  const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run, ...(said ? { steered: () => said } : {}) })
  const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => team.tools(one, kit) }
  const hire: AgentTool = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
  return { paths, hire, models, quick, prompts, signals }
}

describe('c16a: one writer for the helpers\' answer (cause M)', () => {
  it('an anonymous three-way split comes back to the lead as three hand-backs, each helper\'s sentence and link as written; the call does not close the turn', async () => {
    const { hire, models, quick } = await lane('split', '도쿄 오사카 후쿠오카 환율 영향 각각 알아봐서 정리해줘')
    const out = JSON.parse(await hire.run({ members: ['도쿄', '오사카', '후쿠오카'].map(city => ({ role: `${city} 조사`, topic: city, brief: `${city} 여행 경비에 엔화 환율이 주는 영향`, lookup: true })) }, { task: '' })) as Hired
    expect(out.members.map(m => [m.role, m.accepted, m.result])).toEqual(['도쿄', '오사카', '후쿠오카'].map(city => [`${city} 조사`, true, SAID(city)]))
    expect(out.note).toContain('write the answer now')
    expect(hire.closes).toBeUndefined()
    expect(hire.closesOn).toBeUndefined()
    expect(models).toHaveLength(3)
    expect(quick).toHaveLength(0)
  })

  it('the table shape is a rule in the hand-back note, never a table the host builds: what is stored is each helper\'s own words', async () => {
    const { hire, paths, quick } = await lane('prose', '세 도시 엔화 흐름을 하나씩 살펴서 묶어줘')
    const text = await hire.run({ members: three() }, { task: '' })
    expect(quick).toHaveLength(0)
    expect(text.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line))).toHaveLength(0)
    expect((JSON.parse(text) as Hired).note).toContain('one friendly lead sentence that already gives the gist')
    const stored = (await listTasks(paths))[0]!.team!.members
    expect(stored.map(m => m.result)).toEqual(['도쿄', '오사카', '후쿠오카'].map(SAID))
    for (const m of stored) expect(m.data).toBeUndefined()
  })

  it('a part added mid-work ("오키나와도 넣어") comes back with the first three in the one hand-back', async () => {
    const { hire } = await lane('steer', '도쿄 오사카 후쿠오카 환율 영향 각각 알아봐서 정리해줘', { steer: 10, delay: 80 })
    const first = await hire.run({ members: three() }, { task: '' })
    expect(JSON.parse(first).note).toContain('call hire_members now for that part only')
    const out = JSON.parse(await hire.run({ members: [{ role: '오키나와', topic: '오키나와', brief: '오키나와 환율 영향', lookup: true }] }, { task: '' })) as Hired
    expect(out.members.map(m => [m.role, m.result])).toEqual(['도쿄', '오사카', '후쿠오카', '오키나와'].map(city => [city, SAID(city)]))
  })

  it('a split comparison carries one measure to every part and stays on each member (the cell label rule is in the part\'s brief)', async () => {
    const { hire, paths, prompts, quick } = await lane('measure', '태블릿 세 종 값을 하나씩 견줘줘')
    const measure = '가격: 와이파이 기본 모델 최저 용량의 국내 출시가, 원 단위'
    await hire.run({ measure, members: ['갤럭시 탭', '아이패드', '서피스'].map(name => ({ role: name, topic: name, brief: `${name} 가격`, lookup: true })) }, { task: '' })
    expect(prompts).toHaveLength(3)
    for (const prompt of prompts) expect(prompt).toContain(`the same for every part: ${measure}`)
    for (const prompt of prompts) expect(prompt).toContain('A value you can only find on another basis (another model or tier, unit or day) is given labeled with what it is.')
    expect((await listTasks(paths))[0]!.team!.members.map(m => m.measure)).toEqual([measure, measure, measure])
    expect(quick).toHaveLength(0)
  })

  it('"멈춰" while the helpers work: the call ends at once, no helper\'s words are made up and nothing is written after', async () => {
    const { hire, quick, signals } = await lane('stop', '도쿄 오사카 환율 영향 알아봐줘', { hang: true })
    const ctl = new AbortController()
    setTimeout(() => ctl.abort(), 30)
    const at = Date.now()
    const out = JSON.parse(await hire.run({ members: three().slice(0, 2) }, { task: '', signal: ctl.signal })) as Hired
    expect(Date.now() - at).toBeLessThan(1000)
    expect(out.members.map(m => m.state)).toEqual(['failed', 'failed'])
    for (const m of out.members) { expect(m.result).toMatch(/^Failed: /); expect(m.accepted).toBeUndefined() }
    for (const city of ['도쿄', '오사카']) expect(signals.get(city)!.aborted).toBe(true)
    expect(quick).toHaveLength(0)
    expect(hire.closes).toBeUndefined()
  })

  it('a helper that asks the person or made a file leaves the answer to the lead (no hand-back turn)', () => {
    const at = Date.now(), base = { parentId: null, depth: 1, background: true as const, sessionKey: 's', hiredAt: new Date(at).toISOString() }
    const looked: TeamMember = { ...base, id: 'm1', role: '보람', botId: 'b-1', brief: '도쿄 환율', lookup: true, state: 'done', result: '도쿄는 조금 내렸어요. [환율 소식](https://fx.example.jp/tokyo)' }
    const task = (members: TeamMember[]) => ({ id: 't', botId: 'b1', goal: '도쿄 엔화 시세를 살펴서 칸으로 나눠줘', createdAt: new Date(at).toISOString(), team: { members, hires: members.length, maxHires: 8, maxDepth: 2, big: false } }) as unknown as Parameters<typeof employeesAnswer>[0]
    expect(employeesAnswer(task([looked, { ...base, id: 'm2', role: '누리', botId: 'b-2', brief: '표 만들기', state: 'done', result: '만들었어요', files: ['환율표.xlsx'] }]))).toBeUndefined()
    expect(employeesAnswer(task([looked, { ...base, id: 'm2', role: '누리', botId: 'b-2', brief: '표 만들기', state: 'waiting', result: '어느 달 기준으로 할까요?' }]))).toBeUndefined()
    expect((JSON.parse(employeesAnswer(task([looked]))!) as Back).reports.map(one => one.result)).toEqual([looked.result])
  })
})

describe('c16a: the writer works to the answer\'s due (cause F2)', () => {
  const T0 = Date.parse('2026-11-19T01:00:00Z')
  const WORDS = '토요일 강릉은 맑고 낮 12도예요. [기상 예보](https://weather.example.kr/gangneung)'
  const handed = (outcome: Partial<Parameters<typeof settleMember>[1]> = {}): TeamMember => {
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '하람', brief: '강릉 토요일 일요일 하늘 살피기', topic: '강릉 날씨', botId: 'bot-m1', lookup: true, background: true, state: 'working', sessionKey: 's1', hiredAt: new Date(T0 - 20_000).toISOString() }
    settleMember(m, { answer: WORDS, sources: ['https://weather.example.kr/gangneung'], ...outcome }, new Date(T0 - 1000).toISOString(), true)
    return m
  }
  const task = (m: TeamMember) => ({ id: 't', botId: 'b1', goal: '하람이는 강릉 토요일 일요일 하늘 살펴봐', createdAt: new Date(T0 - 20_000).toISOString(), team: { members: [m], hires: 1, maxHires: 8, maxDepth: 2, big: false } }) as unknown as Parameters<typeof employeesAnswer>[0]

  it('a hand-off that came back: the lead step gets the teammate\'s words and page exactly, with no repair in between', () => {
    const m = handed()
    const back = JSON.parse(employeesAnswer(task(m))!) as Back
    expect(back.reports).toEqual([{ who: '하람', part: '강릉 날씨', state: 'done', result: WORDS, sources: ['https://weather.example.kr/gangneung'] }])
    expect(m.result).toBe(WORDS)
    expect(m.data).toBeUndefined()
    expect(partOutcome(m)).toBe('found')
  })

  it('the hand-back is ready the moment it is asked for: no writer argument, no timer, and the note leaves the writing to the lead', () => {
    vi.useFakeTimers({ now: T0 })
    const out = employeesAnswer(task(handed()))
    expect(typeof out).toBe('string')
    expect(Date.now()).toBe(T0)
    expect(vi.getTimerCount()).toBe(0)
    expect(employeesAnswer).toHaveLength(1)
    expect((JSON.parse(out!) as Back).note).toContain('Give the person ONE merged answer in their language')
  })

  it('c16a r2: a teammate cut at its time limit hands back what it had, marked as stopped, and the lead is told to say what is missing', () => {
    const m = handed({ timedOut: true })
    const back = JSON.parse(employeesAnswer(task(m))!) as Back
    expect(back.reports[0]!.result).toBe(m.result)
    expect(back.reports[0]!.result.startsWith(WORDS)).toBe(true)
    expect(back.reports[0]!.result).toMatch(core.CUT_SHORT)
    expect(back.note).toContain('Say plainly which part failed or is missing.')
  })
})

describe('c16a: the fallback reads like one person (cause F2, c15b r3 #1)', () => {
  const GU = 'https://www.suyeong.go.kr/fireworks', BLOG = 'https://blog.naver.com/someone/123', TICKET = 'https://www.suyeong.go.kr/seats'
  it('one part, an event told twice in other words: the teammate\'s three lines reach the lead in its own order with each line\'s own page', () => {
    const lines = [`부산 불꽃축제는 11월 15일 밤 광안리 바닷가에서 시작해요. [수영구청](${GU})`, `블로그에도 11월 15일 광안리라고 나와요. [네이버 블로그](${BLOG})`, `유료 관람석 예매는 11월 3일부터 받아요. [수영구청](${TICKET})`]
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '이든', brief: '부산 불꽃축제 날짜 찾기', topic: '부산 불꽃축제', botId: 'bot-m1', lookup: true, state: 'working', sessionKey: 's1', hiredAt: new Date().toISOString() }
    settleMember(m, { answer: lines.join('\n'), sources: [GU, BLOG, TICKET] }, new Date().toISOString(), true)
    const back = JSON.parse(handBacks([m])) as Back
    expect(back.reports[0]!.result.split('\n')).toEqual(lines)
    expect(back.reports[0]!.sources).toEqual([GU, BLOG, TICKET])
    expect(JSON.stringify(back.reports)).not.toMatch(/이든이 찾아보니|\(이든\)/)
    expect(back.note).toContain('never a line that starts with a name and a colon')
  })

  it('how a day is said is the model\'s rule; a teammate\'s dated sentence is handed back untouched', () => {
    const said = '판교 리액트 밋업이 12월 9일에 열려요. [밋업](https://meetup.example.kr/react)\n판교 개발자 모임은 12월 16일 저녁이에요. [밋업](https://meetup.example.kr/notice)'
    const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '이든', brief: '판교 코딩 모임 알아보기', botId: 'bot-m1', lookup: true, state: 'done', sessionKey: 's1', hiredAt: new Date().toISOString(), result: said }
    expect((JSON.parse(handBacks([m])) as Back).reports[0]!.result).toBe(said)
    expect(COLLEAGUE_CORE_RULE).toContain('a day is said with its date in plain words, never in brackets')
  })

  it('c15b r3 #1: three parts with nothing new each hand back their own sentence; saying it plainly once is the lead\'s rule', () => {
    const quiet = ['피그마', '미로', '캔바'].map((topic, i) => {
      const m: TeamMember = { id: String(i), parentId: null, depth: 1, role: ['하은', '준', '소윤'][i]!, brief: `${topic} 새 기능`, topic, botId: `b${i}`, lookup: true, state: 'working', sessionKey: `s${i}`, hiredAt: new Date().toISOString() }
      settleMember(m, { answer: `${topic}는 이번 주에 새로 나온 기능을 찾지 못했어요.`, sources: [`https://example.com/${i}`] }, new Date().toISOString(), true)
      return m
    })
    expect(quiet.map(m => m.empty)).toEqual([true, true, true])
    const back = JSON.parse(handBacks(quiet)) as Back
    expect(back.reports.map(one => [one.who, one.part, one.sources])).toEqual([['하은', '피그마', ['https://example.com/0']], ['준', '미로', ['https://example.com/1']], ['소윤', '캔바', ['https://example.com/2']]])
    for (const [i, topic] of ['피그마', '미로', '캔바'].entries()) expect(back.reports[i]!.result).toContain(`${topic}는 이번 주에 새로 나온 기능을 찾지 못했어요.`)
    expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place, never left out and never shown as finished.')
  })
})

describe('c16a r2: review findings', () => {
  it('#3: a part the person replaces mid-work ("후쿠오카 말고 오키나와로") is no part of the hand-back; the new part is', async () => {
    const { hire, paths } = await lane('swap', '도쿄 오사카 후쿠오카 환율 영향 각각 알아봐서 정리해줘', { steer: 10, delay: 80 })
    const first = await hire.run({ members: three() }, { task: '' })
    const back = JSON.parse(first) as Hired
    expect(back.note).toContain('give that member id in stop')
    const gone = back.members.find(m => m.role === '후쿠오카')!.id
    const out = JSON.parse(await hire.run({ stop: [gone], members: [{ role: '오키나와', topic: '오키나와', brief: '오키나와 환율 영향', lookup: true }] }, { task: '' })) as Hired
    expect(out.members.map(m => [m.role, m.result])).toEqual(['도쿄', '오사카', '오키나와'].map(city => [city, SAID(city)]))
    expect(JSON.stringify(out.members)).not.toContain('후쿠오카')
    const member = (await listTasks(paths))[0]!.team!.members.find(m => m.id === gone)!
    expect(member).toMatchObject({ state: 'released', review: { ok: false, note: TAKEN_OFF } })
    expect(member.result).toBeUndefined()
  })

  it('c16a r3 (Codex r2 #2): a part the person replaces mid-work stops working at once, not only leaves the answer', async () => {
    const { hire, signals } = await lane('halt', '삿포로 나고야 후쿠오카 환율 영향 각각 알아봐줘', { steer: 10, delay: 300 })
    const back = JSON.parse(await hire.run({ members: three() }, { task: '' })) as Hired
    expect(signals.get('후쿠오카')?.aborted).toBe(false)
    const out = JSON.parse(await hire.run({ stop: [back.members.find(m => m.role === '후쿠오카')!.id], members: [] }, { task: '' })) as Hired
    expect(signals.get('후쿠오카')!.aborted).toBe(true)
    expect(signals.get('도쿄')!.aborted).toBe(false)
    expect(out.members.map(m => m.role)).toEqual(['도쿄', '오사카'])
  })

  it('#3: a stop with nothing new waits for the rest and hands back those alone', async () => {
    const { hire } = await lane('drop', '도쿄 오사카 후쿠오카 환율 영향 각각 알아봐서 정리해줘', { steer: 10, delay: 80 })
    const back = JSON.parse(await hire.run({ members: three() }, { task: '' })) as Hired
    const out = JSON.parse(await hire.run({ stop: [back.members.find(m => m.role === '오사카')!.id], members: [] }, { task: '' })) as Hired
    expect(out.members.map(m => [m.role, m.result])).toEqual(['도쿄', '후쿠오카'].map(city => [city, SAID(city)]))
  })

  it('#1: a helper\'s facts from two pages each keep their own page in what the lead is handed', () => {
    const at = Date.now(), SAM = 'https://www.samsung.com/sec/tablets/galaxy-tab-s11/', YNA = 'https://www.yna.co.kr/view/AKR2026090500001'
    const helper: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '탭 조사', topic: '갤럭시 탭 S11', brief: '갤럭시 탭 S11 가격과 출시일', lookup: true, state: 'released', review: { ok: true, note: 'auto: sourced lookup' }, sessionKey: 's1', hiredAt: new Date(at).toISOString(),
      result: `가격: 기본 모델 국내 출고가 119만 9천 원이에요. [삼성닷컴](${SAM})\n출시일: 2026년 9월 5일에 국내 출시됐어요 ([연합뉴스](${YNA})).`, sources: [SAM, YNA] }
    const other: TeamMember = { ...helper, id: 'm2', topic: '아이패드', brief: '아이패드 가격', result: '아이패드 기본 모델은 59만 9천 원이에요. [애플](https://www.apple.com/kr/ipad/)', sources: ['https://www.apple.com/kr/ipad/'] }
    const back = JSON.parse(handBacks([helper, other])) as Back
    const tab = back.reports.find(one => one.part === '갤럭시 탭 S11')!
    expect(tab.result).toBe(helper.result)
    expect(tab.sources).toEqual([SAM, YNA])
    const lines = tab.result.split('\n')
    expect(lines.find(line => line.includes('119만 9천 원'))).toContain(`](${SAM})`)
    expect(lines.find(line => line.includes('9월 5일'))).toContain(`](${YNA})`)
    expect(JSON.stringify(back.reports).match(/apple\.com/g)).toHaveLength(2)
    expect(back.note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result')
  })

  it('#2: no host writer is left to give a due to: the written-report layer is gone from core and from the runner', () => {
    expect(Object.keys(core).filter(key => /report|merg|helper|written/i.test(key)).sort()).toEqual(['MERGED_SHAPE', 'REPORT_WRITER_MS', 'helpersTool', 'hybridMerge', 'mergeBySubject', 'mergeInto', 'mergeMemory', 'mergeWorkspace', 'pageReport'])
    expect(core.TEAM_ANSWER_MS).toBe(28_000)
    expect(Object.keys(core)).toContain('handBacks')
  })

  it('#2: past the due a part still out is handed back as working with no words; once it is told as late, its own words come back', () => {
    const m = (): TeamMember => {
      const one: TeamMember = { id: 'm1', parentId: null, depth: 1, role: '하람', brief: '강릉 날씨', topic: '강릉', botId: 'bot-1', lookup: true, background: true, late: true, state: 'working', sessionKey: 's', hiredAt: '2026-01-05T01:00:00.000Z' }
      settleMember(one, { answer: '강릉은 맑아요. [예보](https://weather.example.kr/g)', sources: ['https://weather.example.kr/g'] }, '2026-01-05T01:00:30.000Z', true)
      return one
    }
    const task = (lateTold: boolean) => ({ id: 't', botId: 'b1', goal: '하람이는 강릉 날씨 찾아봐', createdAt: '2026-01-05T01:00:00.000Z', team: { members: [m()], hires: 1, maxHires: 8, maxDepth: 2, big: false, ...(lateTold ? { lateTold: true as const } : {}) } }) as unknown as Parameters<typeof employeesAnswer>[0]
    const early = JSON.parse(employeesAnswer(task(false))!) as Back, after = JSON.parse(employeesAnswer(task(true))!) as Back
    expect(early.reports).toEqual([{ who: '하람', part: '강릉', state: 'working', result: '', sources: ['https://weather.example.kr/g'] }])
    expect(after.reports[0]).toMatchObject({ who: '하람', state: 'done', result: '강릉은 맑아요. [예보](https://weather.example.kr/g)' })
  })

  it('#4: a teammate writes a date as its results give it; its own note asks for no report block and the host shows no day of its own', async () => {
    const paths = await vault('rule')
    const bot = await createBot(paths, { name: '하람' })
    const note = await employeeNote(paths, bot.id)
    expect(note).toContain('one of the agents on the person\'s team')
    expect(note).not.toMatch(/report block|"facts"/)
    const persona = memberPersona({ id: 'm1', parentId: null, depth: 1, role: '하람', brief: '강릉 장날 찾기', lookup: true, state: 'hired', sessionKey: 's', hiredAt: new Date().toISOString() })
    expect(persona).toContain('A date is written as the results give it (11월 10일).')
  })
})
