import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { handBacks, handoffBrief, isSearchPage, withLiveSources, runToolSession, settleMember, sourceName, type DelegatedTask, type TeamMember } from 'core'
import * as core from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { answerOnly } from '../src/main/result-check.js'
import * as firstLine from '../src/main/first-line.js'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/prompt.js'

const AT = '2026-11-18T03:00:00.000Z'
const member = (id: string, role: string, brief: string, topic: string, over: Partial<TeamMember> = {}): TeamMember =>
  ({ id, parentId: null, depth: 1, role, brief, topic, botId: `bot-${id}`, lookup: true, background: true, state: 'working', sessionKey: `s-${id}`, hiredAt: AT, ...over })
const settled = (m: TeamMember, answer: string, sources: string[] = []): TeamMember => {
  settleMember(m, { answer, sources }, AT, true)
  return m
}
const job = (members: TeamMember[], goal: string): DelegatedTask => ({ id: 'job', goal, botId: 'lead', state: 'running', turns: 1, createdAt: AT, updatedAt: AT, approvals: [], log: [], team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })
type Report = { who: string; part?: string; state: string; result: string; sources?: string[] }
const handed = (members: TeamMember[]): { reports: Report[]; note: string } => JSON.parse(handBacks(members)) as { reports: Report[]; note: string }
const posted = async (draft: string, ask: string): Promise<string> => answerOnly((await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }) } as never, workdir: '/x', tools: [] }, ask, {})).answer)
const ipc = (): string => readFileSync(new URL('../src/main/ipc.ts', import.meta.url), 'utf8')
const ipcTurn = (): string => { const all = ipc(), from = all.indexOf('await begun!.run({'); return all.slice(from, all.indexOf('answerDelivered = true', from)) }
const fns = (mod: object): string[] => Object.entries(mod).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const FIRST_FNS = ['beginFirstLine', 'cleanLine', 'endFirstLine', 'firstLineCarried', 'firstLineReady', 'firstLineSaw', 'firstLineSpoke', 'firstLineState', 'wantsFirstLine', 'warmFirstLine']

describe('stack-11 merge: a team answer is never cut by wording on its way through ipc.ts', () => {
  const ASK = '밀밭제과랑 호두당 이번 달 새 빵 찾아줘. 다온이랑 시우한테 나눠서'
  const MIL = 'https://www.milbat.example/news/rye-loaf', HODU = 'https://www.hodudang.example/notice/walnut-roll'
  const mil = () => settled(member('m1', '다온', '이번 달 밀밭제과 새 빵 조사', '밀밭제과'), `밀밭제과가 11월 6일에 "Slow Rye Country Loaf Batch Two"를 내놨어요. ${MIL}`, [MIL])
  const hodu = () => settled(member('m2', '시우', '이번 달 호두당 새 빵 조사', '호두당'), `호두당에 11월 11일부터 Maple Walnut Morning Roll이 나와요. ${HODU}`, [HODU])

  it('keeps an English product name the writer quotes from the data, through the writer check and the ipc chain', async () => {
    const got = handed([mil(), hodu()]).reports
    expect(got.map(one => [one.who, one.part, one.state, one.sources])).toEqual([['다온', '밀밭제과', 'done', [MIL]], ['시우', '호두당', 'done', [HODU]]])
    expect(got[0]!.result).toContain('"Slow Rye Country Loaf Batch Two"')
    expect(got[1]!.result).toContain('Maple Walnut Morning Roll')
    const draft = `이번 달엔 두 곳 다 새 빵이 나왔어요.\n\n밀밭제과는 다온이 봤는데 11월 6일에 "Slow Rye Country Loaf Batch Two"가 나왔어요. [밀밭제과](${MIL})\n호두당은 시우가 봤는데 11월 11일부터 Maple Walnut Morning Roll이 나와요. [호두당](${HODU})`
    expect(await posted(draft, ASK)).toBe(draft)
  })

  it('an English run the writer made up is posted as written; keeping a Korean thread Korean is a rule the model reads, and no host check cuts the draft', async () => {
    const draft = `밀밭제과는 다온이 봤는데 "Slow Rye Country Loaf Batch Two"가 나왔어요. [밀밭제과](${MIL})\n\n호두당은 시우가 봤어요, here is the short rundown for the bakery. [호두당](${HODU})`
    expect(await posted(draft, ASK)).toBe(draft)
    expect(COLLEAGUE_CORE_RULE).toContain('In a Korean thread every line is Korean except names, code, addresses, file names and text they asked for in another language')
    expect(COLLEAGUE_CORE_RULE).toContain('Your reply reaches the person exactly as you write it')
    expect(ipcTurn().match(/result\.answer = /g)).toHaveLength(1)
    expect(Object.keys(JSON.parse(handBacks([mil(), hodu()])) as object)).toEqual(['reports', 'note'])
    expect(job([mil(), hodu()], ASK).team!.members.every(m => m.data === undefined)).toBe(true)
  })
})


describe('stack-11 merge: one helper each', () => {
  it('"is a search page" is core\'s isSearchPage for the lone lookup and the team alike', async () => {
    for (const url of ['https://search.daum.net/search?q=x', 'https://m.search.naver.com/search.naver?query=x', 'https://www.google.com/search?q=x', 'https://shop.example.com/list?search=chair']) expect(isSearchPage(url), url).toBe(true)
    expect(isSearchPage('https://www.hankyung.com/article/2026111712345')).toBe(false)
    const asked: string[] = []
    const m = { ...member('m1', '수주', '요즘 조선업 수주 기사 2개', '조선업'), state: 'done' as const, result: '1. 첫 소식 — https://news.example/a\n2. 둘째 — https://shop.example.com/list?search=ship', sources: ['https://shop.example.com/list?search=ship'] }
    expect(await withLiveSources([m], async url => { asked.push(url); return true })).toBe(false)
    expect(asked.sort()).toEqual(['https://news.example/a', 'https://shop.example.com/list?search=ship'])
  })
})

describe('stack-11: Codex-cap findings', () => {
  it('c11a r3 #1: a site word that is a label, a piece of the address or no text at all is no link name; the host names the page', () => {
    const night = 'https://unlisted-garden.example.net/night'
    expect(sourceName(night, true)).toBe('unlisted-garden.example.net')
    for (const site of ['출처', 'link', 'unlisted-garden', 7]) expect(core.siteOf(night, site), String(site)).toBe('unlisted-garden.example.net')
    expect(core.siteOf('https://unlisted-garden.example.net/n2', '푸른수목원')).toBe('푸른수목원')
    const m = settled(member('m1', '다온', '수목원 행사 조사', '수목원'), `수목원 야간 개장이 있어요. ${night}`, [night])
    expect(handed([m]).reports[0]).toMatchObject({ result: `수목원 야간 개장이 있어요. ${night}`, sources: [night] })
    expect(COLLEAGUE_CORE_RULE).toContain('Nothing technical is ever shown: no tool or function names, ids')
    expect(COLLEAGUE_CORE_RULE).toContain('never a site name without its link')
    expect(Object.keys(JSON.parse(handBacks([m])) as object)).toEqual(['reports', 'note'])
  })

  it('c11b r3 #1: on a lookup loop, words said before a call never stand in as the answer', async () => {
    const { runToolSession } = await import('core')
    let runs = 0
    const engine = { id: 'mock', runTools: async () => (++runs === 1 ? { answer: '', note: '우선 관련 기사부터 훑어볼게요.' } : { answer: '' }) }
    const r = await runToolSession({ engine: engine as never, workdir: '/x', tools: [] }, '이번 주 반도체 장비 수출 기사 알려줘', { lookup: true })
    expect([runs, r.answer]).toEqual([2, ''])
    runs = 0
    const save = await runToolSession({ engine: engine as never, workdir: '/x', tools: [] }, '금요일 치과 예약 기억해', {})
    expect(save.answer).toBe('우선 관련 기사부터 훑어볼게요.')
  })

  it('c13b (c11b r3 #2): a dead page is taken off a teammate\'s hand-back before the lead writes, and no list loses a line or gains a host label on the way out', async () => {
    const gone = 'https://closed.example/ferry-a', live = 'https://harbor.example/ferry-b'
    const m = settled(member('m1', '다온', '이번 달 여객선 시간표 소식 2개', '여객선'), `1. 통영 첫 배가 30분 당겨졌어요. ${gone}\n2. 욕지도 막배가 저녁 6시로 늦춰졌어요. ${live}`, [gone, live])
    expect(await withLiveSources([m], async url => !url.includes('closed.example'))).toBe(true)
    expect(m.result).not.toContain(gone)
    expect(handed([m]).reports[0]!.result).toContain(live)
    const answer = `이번 달엔 한 건만 확인됐어요.\n\n1. 욕지도 막배가 저녁 6시로 늦춰졌어요. [항만 공지](${live})`
    expect(await posted(answer, '이번 달 여객선 시간표 소식 2개만')).toBe(answer)
    expect(ipc()).not.toMatch(/listShortfall|shortfall: \(answer: string\) =>/)
    expect(ipcTurn().match(/result\.answer = /g)).toHaveLength(1)
  })
})

describe('stack-11: a reply in a Korean thread with no Korean word gets the words that hand it over', () => {
  it('the warm Korean words before an asked-for foreign line are the model\'s to write: the rule says so and the line is posted exactly, with or without them', async () => {
    const line = 'chore: sort the ferry timetable by departure pier'
    expect(await posted(line, '이 수정 내용 커밋 제목 영문으로 하나')).toBe(line)
    const led = `커밋 메시지는 이렇게 쓰시면 돼요.\n\n${line}`
    expect(await posted(led, '이 수정 내용 커밋 제목 영문으로 하나')).toBe(led)
    const code = '이렇게 조회하면 돼요.\n\n```sql\nSELECT pier FROM sailings WHERE leaves > \'06:00\';\n```'
    expect(await posted(code, '6시 이후 배 조회 쿼리')).toBe(code)
    expect(COLLEAGUE_CORE_RULE).toContain('text they asked for in another language, which you hand over unchanged after a few warm Korean words')
    expect(fns(firstLine)).toEqual(FIRST_FNS)
  })
  it('ipc runs no pass over the answer before delivery: the files are attached to the answer the model wrote', () => {
    expect(ipcTurn().match(/result\.answer = /g)).toHaveLength(1)
    expect(ipc()).toMatch(/const answered = answerOnly\(result\.answer\)/)
    expect(ipc()).toMatch(/const linked = \(\): string => withFiles\(result\.answer, result\.files\)/)
  })
})

describe('stack-11: working notes and date ranges', () => {
  it('a line of working notes is the model\'s not to write: the rule forbids it, nothing after the answer drops a line, and an asked-for English line, a quoted title and code stay', async () => {
    const answer = ['Found three solid rows, writing them up now in order.', '', '1. 도서관 새 분관이 12월 3일에 문을 열어요. [구청 소식](https://www.gu.example/library/1)', '2. "Night Reading Room Pilot Announced" 발표 소식이에요.', '3. Night Reading Room Pilot Announced [City Desk](https://www.citydesk.example/x)'].join('\n')
    expect(await posted(answer, '요즘 도서관 개관 소식 3개만')).toBe(answer)
    const asked = '부탁하신 문장이에요.\n\nCould we move the book club to Thursday evening instead?'
    expect(await posted(asked, '독서 모임 목요일 저녁으로 옮기자는 영어 문장 하나 써줘')).toBe(asked)
    const script = '스크립트예요.\n```sh\necho sorting all the returned books now\n```'
    expect(await posted(script, '반납 도서 정리 스크립트')).toBe(script)
    expect(COLLEAGUE_CORE_RULE).toContain('no opening line about what you are about to do, no account of your steps and no notes to yourself')
    expect(fns(firstLine)).toEqual(FIRST_FNS)
    expect(ipcTurn().match(/result\.answer = /g)).toHaveLength(1)
  })
  it('a day range is a date, read as its last day', async () => {
    const { resultDay } = await import('core')
    const now = new Date(2026, 10, 17)
    expect(resultDay('10월 3~7일', now)?.getDate()).toBe(7)
    expect(resultDay('10월 첫째주(1~6일)', now)?.getDate()).toBe(6)
    expect(resultDay('10월 5일', now)?.getDate()).toBe(5)
    expect(resultDay('11월 10~12일', now)?.getDate()).toBe(12)
    expect(resultDay('11월 셋째주(15~16일)', now)?.getDate()).toBe(16)
  })
})

describe('stack-11: one deliverable line from a writer teammate', () => {
  it('reaches the lead as a line of its own, numbered or not, exactly as the writer wrote it, with the giver\'s fact and page beside it', () => {
    const tide = 'https://www.tide.example.kr/w/boryeong'
    const fact = `일요일 보령은 오전 9시에 물이 가장 많이 빠져요. ${tide}`
    const line = '물 빠진 일요일 아침, 보령 갯벌 산책 어때요?'
    for (const written of [line, `1. ${line}`]) {
      const giver = settled(member('m1', '다온', '이번 주 보령 물때 조사', '보령', { then: { botId: 'bot-m2', who: '시우', brief: '그걸로 갯벌 산책 권하는 문구 한 줄' } }), fact, [tide])
      const brief = handoffBrief('그걸로 갯벌 산책 권하는 문구 한 줄', '다온', giver.result!, giver.brief)
      expect(brief).toContain(fact)
      const copy = settled(member('m2', '시우', brief, '보령 문구', { writer: true, lookup: undefined }), written)
      const got = handed([giver, copy])
      expect(got.reports.map(one => one.result)).toEqual([fact, written])
      expect(got.reports[0]!.sources).toEqual([tide])
      expect(got.note).toContain('Where one agent handed their result to the next, the last result is the deliverable; keep the facts it took from the earlier one.')
    }
  })
})
