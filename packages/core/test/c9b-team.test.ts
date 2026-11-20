import { beforeEach, expect, test, vi } from 'vitest'
import { employeesAnswer, firstFound, firstSearches, handBacks, handedFrom, handoffBrief, makerFirst, makerOf, searchWords, topicOf, WRITER_RULE } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { foundNothing, LOOKUP_RULE, settleMember } from '../src/team-hire-tools.js'

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-17T03:00:00Z') }) })

const firsts = (brief: string, about = brief) => firstSearches({ brief, query: searchWords(brief, new Date(), about) }, about)

test('c9 fix 1: a job about a named product opens with the news search and the maker\'s own updates page, by its Latin name', () => {
  const slack = firsts('이번 주 슬랙 신기능 조사', '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘')
  expect(slack).toEqual([{ query: '슬랙 앱 새 기능 업데이트', news: true }, { query: 'Slack release notes 업데이트', maker: 'Slack' }])
  expect(firsts('지난주 피그마 업데이트 뭐 있었어?')[1]).toEqual({ query: 'Figma release notes 업데이트', maker: 'Figma' })
  expect(firsts('디스코드 새 기능')).toEqual([{ query: '디스코드 새 기능 업데이트' }, { query: 'Discord patch notes 업데이트', maker: 'Discord' }])
  expect(makerOf('리니어', '경쟁사 리니어(Linear) 조사')).toEqual({ name: 'Linear', query: 'Linear changelog' })
  expect(firsts('이번 주 플로우잇(Flowit) 신기능 조사')[1]).toEqual({ query: 'Flowit changelog 업데이트', maker: 'Flowit' })
  expect(firsts('이번 주 모아보기 앱 신기능 조사')).toHaveLength(1)
  for (const brief of ['이번 주 노션 신기능 조사', '오늘 슬랙 새 기능 조사', '다음 달 서울 IT 행사 일정 정리']) {
    const all = firsts(brief)
    expect(all.length).toBeLessThanOrEqual(2)
    expect(new Set(all.map(one => one.query.toLowerCase())).size).toBe(all.length)
    expect(all.map(one => one.query).join(' ')).not.toMatch(/이번\s?주|오늘|다음\s?달/u)
  }
})

test('c9 fix 3: a list job is searched twice in different words; a plain lookup once', () => {
  const events = firsts('다음 달 서울 IT 행사 일정 정리')
  expect(events).toHaveLength(2)
  expect(events[1]!.query).toMatch(/컨퍼런스 세미나 밋업/)
  expect(firsts('부산 맛집 목록 정리')[1]!.query).toMatch(/식당 추천/)
  expect(firsts('이번 주말 서울 날씨 찾아봐')).toHaveLength(1)
})

test('c9 fix 1: the maker\'s own rows come first and are said so to the teammate', () => {
  const found = 'results for "Linear changelog" at https://www.bing.com/search?q=Linear+changelog (DATA)\n- Linear actuator guide — https://example.com/actuator — motors\n- Changelog — https://linear.app/changelog — Nov 13, 2026 — Agents in Linear'
  const out = makerFirst(found, 'Linear')
  expect(out.own).toBe(true)
  expect(out.found.split('\n')[1]).toContain('linear.app/changelog')
  expect(makerFirst('results for "x" at https://a.b (DATA)\n- A — https://example.com/a — a', 'Linear').own).toBe(false)
  const told = firstFound([{ query: '리니어 앱 새 기능 업데이트', news: true, found: 'results for "a"' }, { query: 'Linear changelog', maker: 'Linear', ...out }])
  expect(told).toContain('read_pages')
  expect(told).toContain('이번 주엔 새로 낸 게 없어요')
})

const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '서연', brief: '이번 주 슬랙 신기능 조사', state: 'done', sessionKey: 'k', hiredAt: '2026-11-17T02:59:00Z', lookup: true, botId: 'b1', ...over })

interface Back { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
const back = (text: string | undefined): Back => JSON.parse(text!) as Back
const AT = '2026-11-17T03:00:00.000Z'

test('c9 fix 1 → k1: a lookup that only saw unrelated results is settled as having found nothing, its words reach the lead as written, and not describing the search is the teammate\'s rule', () => {
  const found = member({ id: 'm1', role: '지민', topic: '노션', brief: '이번 주 노션 신기능 조사', state: 'working' })
  settleMember(found, { answer: '노션은 11월 12일에 회의 메모 정리 기능을 냈어요. https://www.notion.com/releases', sources: ['https://www.notion.com/releases'] }, AT, true)
  const none = member({ id: 'm2', role: '서연', topic: '슬랙', state: 'working' })
  settleMember(none, { answer: '슬랙은 이번 주에 새로 나온 기능 소식이 없어요.', sources: ['https://search.naver.com/search.naver?query=slack'] }, AT, true)
  expect([found.empty, none.empty]).toEqual([undefined, true])
  const out = back(handBacks([found, none]))
  expect(out.reports.map(r => [r.who, r.part, r.result])).toEqual([['지민', '노션', '노션은 11월 12일에 회의 메모 정리 기능을 냈어요. https://www.notion.com/releases'], ['서연', '슬랙', '슬랙은 이번 주에 새로 나온 기능 소식이 없어요.']])
  expect(LOOKUP_RULE).toContain('never write about time, limits, attempts, tools, pages that did not open or what you failed to do')
  expect(foundNothing('이번 주 기준으로는 슬랙 신기능 관련 구체적인 소식이 안 잡히더라고요!')).toBe(true)
})

const TRAIL_FIND = '다음 달 북한산 둘레길 걷기 행사는 세 번 열려요.\n\n- 12월 5일(토): 우이령길 아침 걷기, 우이동 입구 — https://trail.example.kr/walk/1205\n- 12월 12일(토): 솔밭길 가족 걷기, 솔밭공원 — https://trail.example.kr/walk/1212\n- 12월 19일(토): 해넘이 걷기, 정릉 탐방소 — https://park.example.kr/sunset'
const TRAIL_COPY = '12월 5일 아침, 우이령길에서 같이 걸어요\n솔밭길 가족 걷기, 12월 12일에 아이 손 잡고 오세요\n올해 마지막 해넘이는 12월 19일 정릉에서'
const giver = (voice?: string): TeamMember => member({ role: '지민', lookup: true, brief: '다음 달 북한산 둘레길 걷기 모임 날짜 모으기', title: '다음 달 북한산 둘레길 걷기 모임 날짜 모으기', topic: topicOf('다음 달 북한산 둘레길 걷기 모임 날짜 모으기'), background: true, result: TRAIL_FIND, ...(voice ? { voice } : {}), then: { botId: 'b2', who: '서연', brief: '안내 글 세 줄 짓기' } })
const taker = (voice?: string): TeamMember => member({ id: 'm2', botId: 'b2', role: '서연', ...(voice ? { voice } : {}), lookup: undefined, writer: true, background: true, brief: handoffBrief('안내 글 세 줄 짓기', '지민', TRAIL_FIND, '다음 달 북한산 둘레길 걷기 모임 날짜 모으기'), title: '안내 글 세 줄 짓기', result: TRAIL_COPY })
const job = (members: TeamMember[]): DelegatedTask => ({ id: 't', goal: '둘레길 행사 찾아서 문구 써줘', botId: 'lead', state: 'waiting', turns: 1, createdAt: AT, updatedAt: AT, approvals: [], log: [], team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })

test('c9 fix 2/3 → k1: a find and the copy made from it both reach the lead as written, the copy\'s brief holds the find, and which one is the deliverable is the lead\'s rule', () => {
  const out = back(employeesAnswer(job([giver(), taker()])))
  expect(out.reports.map(r => [r.who, r.result])).toEqual([['지민', TRAIL_FIND], ['서연', TRAIL_COPY]])
  expect(out.reports[1]!.result.split('\n')).toHaveLength(3)
  for (const address of ['https://trail.example.kr/walk/1205', 'https://trail.example.kr/walk/1212', 'https://park.example.kr/sunset']) expect(out.reports[0]!.result).toContain(address)
  expect(handedFrom(taker().brief)).toMatchObject({ brief: '안내 글 세 줄 짓기', from: '지민', result: TRAIL_FIND })
  expect(out.note).toContain('Where one agent handed their result to the next, the last result is the deliverable; keep the facts it took from the earlier one.')
  expect(out.note).toContain('No sections per agent, no closing offer or question.')
})

test('c9 fix 2 → k1: a writer\'s answer is kept whole, its own closing line included: the host removes no sentence, and writing only the deliverable is the writer\'s rule', () => {
  const find = '이번 주말 설악산은 토요일 새벽 영하 4도, 낮 3도에 바람이 약하대요. https://www.weather.go.kr/w/b'
  const brief = handoffBrief('주말 산행 안내 글 한 편 지어줘', '지민', find, '이번 주말 설악산 날씨 찾기')
  const answer = '낮 3도에 바람도 약한 토요일, 울산바위까지 천천히 올라요\n지민이가 찾아준 날씨는 기상청에서 본 거예요.'
  const park = member({ role: '서연', lookup: undefined, writer: true, background: true, brief, state: 'working' })
  settleMember(park, { answer }, AT, true)
  expect(park.result).toBe(answer)
  expect(park.data).toBeUndefined()
  expect(back(handBacks([park])).reports[0]!.result).toBe(answer)
  expect(WRITER_RULE).toContain('items: the finished deliverable')
  expect(WRITER_RULE).toContain('no draft, no alternative, no remark about it')
})

test('c9b r2 finding 1: any job about a named product opens with the maker\'s own page too, not only an updates job', () => {
  expect(firsts('이번 주 슬랙 가격 조사')).toEqual([{ query: '슬랙 가격', news: true }, { query: 'Slack release notes 업데이트', maker: 'Slack' }])
  expect(firsts('노션 요금제 정리')).toEqual([{ query: '노션 요금제' }, { query: 'Notion releases 업데이트', maker: 'Notion' }])
  expect(firsts('플로우잇(Flowit) 가격 조사')[1]).toEqual({ query: 'Flowit changelog 업데이트', maker: 'Flowit' })
  expect(firsts('이번 주 KOSPI 지수 조사')).toHaveLength(1)
  expect(firsts('이번 주 모아보기 앱 가격 조사')).toHaveLength(1)
  const told = firstFound([{ query: '슬랙 가격', news: true, found: 'results for "a"' }, { query: 'Slack release notes', maker: 'Slack', found: 'x', own: true }])
  expect(told).toMatch(/When your part is about what Slack has put out or changed, read that one page/)
})

test('c9b r2 finding 2 → k1: a teammate\'s stored voice changes nothing in what the lead is handed: the same words, pages and note for every voice', () => {
  const plain = employeesAnswer(job([giver(), taker()]))!
  for (const voice of ['차분하고 또박또박', '밝고 시원시원하게', '담백하고 짧게', '사투리로']) expect(employeesAnswer(job([giver(voice), taker(voice)]))).toBe(plain)
  expect(plain).not.toContain('차분하고')
  expect(back(plain).reports.map(r => r.result)).toEqual([TRAIL_FIND, TRAIL_COPY])
  expect(Object.keys(back(plain).reports[0]!).sort()).toEqual(['part', 'result', 'state', 'who'])
})

test('c9b r3 → k1: a teammate\'s answer is settled to the same result whatever its stored voice, so the lead writes from the teammate\'s own words', () => {
  const answer = '12월 5일에 우이령길 아침 걷기가 열려요. https://trail.example.kr/walk/1205'
  const results = ['밝고 시원시원하게', '담백하고 짧게', '차분하고 또박또박'].map(voice => {
    const m = member({ role: '서연', voice, brief: '북한산 둘레길 걷기 모임 날짜 모으기', lookup: true, state: 'working' })
    settleMember(m, { answer, sources: ['https://trail.example.kr/walk/1205'] }, AT, true)
    return [m.result, m.said, m.review?.ok, back(handBacks([m])).reports[0]!.result]
  })
  for (const one of results) expect(one).toEqual([answer, answer, true, answer])
})
