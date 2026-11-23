import { expect, test } from 'vitest'
import { COLLEAGUE_CORE_RULE } from '../src/agent-voice.js'
import { createBot, updateBot } from '../src/bots.js'
import * as company from '../src/company-tools.js'
import { assignTool, employeeNote, employeesAnswer, handBacks, handedFrom, handoffBrief, partOutcome, WRITER_RULE, type AssignHost } from '../src/company-tools.js'
import type { DelegatedTask, TeamMember } from '../src/delegated-tasks.js'
import { keptItems, settleMember, sourceName } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-11-18T03:00:00Z')
const at = new Date(NOW.getTime() - 5_000).toISOString()
const member = (over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'role' | 'brief'>): TeamMember => ({ parentId: null, depth: 1, botId: `bot-${over.id}`, lookup: true, background: true, state: 'hired', sessionKey: `s-${over.id}`, hiredAt: at, ...over })
const settled = (m: TeamMember, answer: string, sources: string[] = []): TeamMember => {
  settleMember(m, { answer, sources }, NOW.toISOString(), true)
  return m
}
const links = (text: string): string[] => [...text.matchAll(/\[([^\]]+)\]\((https?:[^)]+)\)/g)].map(one => one[1]!)
interface Back { added?: string[]; reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
const back = (text: string | undefined): Back => JSON.parse(text!) as Back
const job = (members: TeamMember[]): DelegatedTask => ({ id: 't', goal: 'g', botId: 'lead', state: 'waiting', turns: 1, createdAt: at, updatedAt: at, approvals: [], log: [], team: { members, hires: members.length, maxHires: 8, maxDepth: 3, big: false } })

const BRANCHES: Record<string, { topic: string; answer: string; page: string }> = {
  민준: { topic: '중앙도서관', answer: '중앙도서관은 11월 6일부터 열람실을 밤 10시까지 열어요. [중앙도서관](https://central-lib.example.kr/notice/1123)', page: 'https://central-lib.example.kr/notice/1123' },
  지아: { topic: '강변도서관', answer: '강변도서관은 이번 달 바뀐 게 없어요. 10월 21일 휴관일 안내가 마지막이에요. [강변도서관](https://river-lib.example.kr/news/501)', page: 'https://river-lib.example.kr/news/501' },
  하율: { topic: '숲속도서관', answer: '숲속도서관은 11월 3일에 어린이실을 새로 열었어요. [숲속도서관](https://forest-lib.example.kr/open/2026)', page: 'https://forest-lib.example.kr/open/2026' },
}

test('a split research ask: assign hands the lead each part as the teammate wrote it, links and all, and the merged answer is the lead\'s own to write', async () => {
  const paths = await initVault(await tmpVaultRoot('c11a-assign'), { git: false })
  const lead = await createBot(paths, { name: '엔그램' })
  const task = { id: 't1', goal: '도서관 세 곳 이번 달 변경 사항', botId: lead.id, state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [] } as DelegatedTask
  const host: AssignHost = {
    self: null, load: async () => task, change: async work => work(task),
    run: async ids => { for (const m of task.team!.members.filter(one => ids.includes(one.id))) settled(m, BRANCHES[m.role]!.answer, [BRANCHES[m.role]!.page]) },
    release: async ids => { for (const m of task.team!.members) if (ids.includes(m.id)) m.state = 'released' },
    live: () => false, tokensLeft: async () => 100_000, personSaid: () => '', later: async () => undefined, attach: async () => false,
  }
  const out = back(await assignTool(paths, host, () => undefined).run({ wait: true, to: Object.entries(BRANCHES).map(([who, one]) => ({ who, brief: `이번 달 ${one.topic} 변경 사항 조사`, topic: one.topic })) }, { task: '' }))
  expect(out.reports.map(r => [r.who, r.part, r.state, r.result])).toEqual(Object.entries(BRANCHES).map(([who, one]) => [who, one.topic, 'done', one.answer]))
  expect(out.reports.flatMap(r => links(r.result))).toEqual(['중앙도서관', '강변도서관', '숲속도서관'])
  expect(out.reports.map(r => r.sources)).toEqual(Object.values(BRANCHES).map(one => [one.page]))
  expect(task.team!.members.map(m => m.data)).toEqual([undefined, undefined, undefined])
  expect(out.note).toContain('Give the person ONE merged answer in their language that reads as the teammates talking')
  expect(out.note).not.toMatch(/더라고요|네요|in every sentence/)
})

test('what the structure check refused is now asked of the lead in the hand-back note: no name-and-colon line, every teammate named, each source linked from what was handed back; no check is left to refuse an answer', () => {
  const { note } = back(handBacks(Object.entries(BRANCHES).map(([who, one], i) => member({ id: `m${i + 1}`, role: who, brief: one.topic, topic: one.topic, state: 'done', result: one.answer }))))
  expect(note).toContain('never a line that starts with a name and a colon')
  expect(note).toContain('who did what in natural sentences that name each agent')
  expect(note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result, never a site name alone')
  expect(note).toContain('Say plainly which part failed or is missing.')
  expect(Object.entries(company).filter(([name, value]) => typeof value === 'function' && /report|answer|check|merge|written|kind|period/i.test(name)).map(([name]) => name).sort()).toEqual(['employeesAnswer'])
})

test('a handoff that makes copy: the copy\'s brief holds the find as written, and the writer\'s answer is its result exactly; writing only the final lines is the writer\'s rule', () => {
  const find = '망원시장 안 고로케 가게가 요즘 줄 서는 곳이에요. — https://market.example.kr/food/123'
  const giver = settled(member({ id: 'm1', role: '민준', brief: '망원시장 근처 간식 가게 찾기', then: { botId: 'bot-m2', who: '지아', brief: '가게 소개 글 두 편 써' } }), find, ['https://market.example.kr/food/123'])
  const brief = handoffBrief('가게 소개 글 두 편 써', '민준', giver.result!, giver.brief)
  expect(brief).toContain(find)
  expect(handedFrom(brief)).toMatchObject({ from: '민준', result: find })
  const raw = '망원시장 고로케, 줄 서도 아깝지 않은 한 입\n시장 골목 끝에서 만나는 갓 튀긴 고로케'
  const copy = settled(member({ id: 'm2', role: '지아', brief, lookup: undefined, writer: true }), raw)
  expect(copy.result).toBe(raw)
  expect(copy.data).toBeUndefined()
  expect(back(handBacks([giver, copy])).reports.map(r => r.result)).toEqual([find, raw])
  expect(WRITER_RULE).toContain('each final text only')
  expect(WRITER_RULE).toContain('no draft, no alternative, no remark about it, no number in front')
  expect(WRITER_RULE).toContain('uses at least one of its facts as it is')
})

test('a list job: an item whose only link is a search page never reaches the lead; every other item the teammate wrote does, with its own page', () => {
  const answer = ['12월 4일 한강 야간 달리기 모임 https://run.example.kr/events/5521', '12월 6일 강변 요가 모임 https://yoga.example.com/class/88', '12월 11일 새벽 달리기 모임 https://search.naver.com/search.naver?query=%EB%8B%AC%EB%A6%AC%EA%B8%B0', '12월 15일 초보 달리기 교실 https://www.meetup.com/han-run/events/77'].join('\n')
  const runs = settled(member({ id: 'm1', role: '하율', brief: '다음 달 한강 달리기 모임 일정 정리', topic: '한강 달리기' }), answer)
  const handed = back(handBacks([runs])).reports[0]!.result
  expect(handed).not.toMatch(/새벽 달리기|search\.naver\.com/)
  expect(handed.split('\n')).toEqual(answer.split('\n').filter(line => !line.includes('search.naver.com')))
  expect(handed.match(/https:\/\/\S+/g)).toHaveLength(3)
  expect(handed).toContain('강변 요가 모임')
})

test('a compare job: both parts reach the lead with their figures and pages, a table is the lead\'s choice only when asked to compare, and an unknown site is named by its host', () => {
  const a = settled(member({ id: 'm1', role: '민준', brief: '제주행 여객선 요금이랑 첫 배 시간', topic: '제주행' }), '요금은 3만 2천 원이에요. [한일고속](https://ferry-a.example.com/jeju)\n첫 배는 오전 9시예요. [항만공사](https://port.example.kr/timetable/jeju)')
  const b = settled(member({ id: 'm2', role: '지아', brief: '울릉도행 여객선 요금이랑 첫 배 시간', topic: '울릉도행' }), '요금은 6만 8천 원이에요. [ferry-b.example.com](https://ferry-b.example.com/ulleung)')
  const out = back(handBacks([a, b]))
  expect(out.reports.flatMap(r => links(r.result))).toEqual(['한일고속', '항만공사', 'ferry-b.example.com'])
  for (const figure of ['3만 2천 원', '오전 9시', '6만 8천 원']) expect(JSON.stringify(out.reports)).toContain(figure)
  expect(out.note).toContain('A table only when the person asked to compare or for a table.')
  expect(sourceName('https://unknown-review-site.example/post/1', true)).toBe('unknown-review-site.example')
})

test('no writer stands in for the lead: a part still at work is handed back as working with no words, a finished one with its words, and nothing is handed back while a part needs the person', () => {
  const done = settled(member({ id: 'm4', role: '도윤', brief: '이번 달 마을문고 변경 사항 조사', topic: '마을문고' }), '마을문고는 11월 9일에 토요일 운영을 시작했어요. https://village-lib.example.kr/x', ['https://village-lib.example.kr/x'])
  const still = member({ id: 'm5', role: '서아', brief: '이번 달 책마루 변경 사항 조사', topic: '책마루', state: 'working' })
  const out = back(employeesAnswer(job([done, still])))
  expect(out.reports.map(r => [r.part, r.who, r.state, r.result])).toEqual([['마을문고', '도윤', 'done', done.result], ['책마루', '서아', 'working', '']])
  expect([done, still].map(partOutcome)).toEqual(['found', 'working'])
  const asking = member({ id: 'm6', role: '온유', brief: '대출 기록 확인', state: 'waiting', result: '어느 지점 기록을 볼까요?' })
  expect(employeesAnswer(job([done, asking]))).toBeUndefined()
  expect(employeesAnswer(job([]))).toBeUndefined()
})

test('persona: a temperament with no fixed ending, never "in every sentence", none in a writer\'s deliverable prompt, and the report block is asked of a lookup and a writer only', async () => {
  const paths = await initVault(await tmpVaultRoot('c11a-team'), { git: false })
  await createBot(paths, { name: '엔그램' })
  const bot = await createBot(paths, { name: '지아', purpose: '글 담당' })
  await updateBot(paths, bot.id, { label: '글 담당' })
  const plain = await employeeNote(paths, bot.id, NOW), writer = await employeeNote(paths, bot.id, NOW, 'writer'), lookup = await employeeNote(paths, bot.id, NOW, 'lookup')
  for (const note of [plain, writer, lookup, WRITER_RULE]) expect(note).not.toMatch(/in every sentence|더라고요|…네요|확인해 보니/)
  for (const note of [plain, writer]) expect(note).not.toMatch(/```report|"facts"|"items"|JSON/)
  expect(lookup).toContain('```report, holding JSON and nothing before or after it: {"facts":[')
  expect(WRITER_RULE).toContain('```report, holding JSON and nothing before or after it: {"items":[')
  expect(plain).toMatch(/temperament/)
  expect(writer).not.toMatch(/temperament/)
  expect(WRITER_RULE).toContain('one entry per piece, exactly as many as the job asks')
})

test('a teammate\'s answer is its result whatever its shape: prose, numbered lines or a fenced block are all kept as written and none becomes data', () => {
  const answers = ['강변도서관은 바뀐 게 없더라고요.', '1. 하나\n2. 둘\n3. 셋', '```report\n{"facts":[{"text":"열람실 연장","url":"https://a.example/p"}]}\n```', '열람실 연장 https://a.example/p']
  for (const [i, answer] of answers.entries()) {
    const m = settled(member({ id: `m${i}`, role: '지아', brief: '강변도서관 변경 사항 조사', ...(i === 1 ? { lookup: undefined, writer: true as const } : {}) }), answer)
    expect(m.result).toBe(answer)
    expect(m.data).toBeUndefined()
    expect(m.state).toBe('done')
  }
})

test('r2: inner words a page used are not rewritten by the host: the teammate\'s line is handed back as written, and never saying them to the person is the voice rule', () => {
  const answer = '상담 AI 에이전트와 프롬프트 편집기가 나왔고, 대화 세션 기록이 길어졌어요. https://helpdesk.example.kr/blog/new'
  const m = settled(member({ id: 'm1', role: '소희', brief: '이번 주 고객센터 툴 신기능 조사', topic: '고객센터 툴' }), answer, ['https://helpdesk.example.kr/blog/new'])
  expect(m.result).toBe(answer)
  expect(back(handBacks([m])).reports[0]!.result).toBe(answer)
  expect(COLLEAGUE_CORE_RULE).toContain('never speak of 세션, 턴, 토큰, 프롬프트, 런타임 or 컨텍스트')
  expect(COLLEAGUE_CORE_RULE).toContain('use everyday words a non-developer uses')
})

test('r2: a hand-off whose receiver ended with nothing still hands the lead the giver\'s sourced find, and the receiver as failed', () => {
  const find = '성수에서 향수 팝업 전시가 토요일까지 열려요. https://popup.example.kr/seongsu/77'
  const giver = settled(member({ id: 'g', role: '태오', brief: '이번 주말 성수 팝업 전시 조사', then: { botId: 'bot-r', who: '윤서', brief: '소개 문장 두 개 써' } }), find, ['https://popup.example.kr/seongsu/77'])
  const receiver = member({ id: 'r', role: '윤서', lookup: false, writer: true, brief: handoffBrief('소개 문장 두 개 써', '태오', giver.result!, giver.brief) })
  settleMember(receiver, { answer: '' }, NOW.toISOString(), true)
  expect(receiver.state).toBe('failed')
  expect(partOutcome(receiver)).toBe('unfinished')
  const out = back(handBacks([giver, receiver]))
  expect(out.reports[0]).toMatchObject({ who: '태오', state: 'done', result: find })
  expect(out.reports[0]!.result).toContain('https://popup.example.kr/seongsu/77')
  expect(out.reports[1]).toMatchObject({ who: '윤서', state: 'failed' })
  expect(out.note).toContain('Say plainly which part failed or is missing.')
})

test('r2: nothing judges the kind of what a teammate brought (c19a r2: it drops nothing the teammate brought): each line with its own page stays', () => {
  const brief = '이번 달 강남 와인 시음회 목록'
  const lines = ['청담에서 내추럴 와인 시음회가 열려요. https://wine.example.kr/e/1', '자동차 셀프 정비 강좌가 열려요. https://car.example.kr/c/9', '논현에서 부르고뉴 와인 시음 모임이 있어요. https://wine.example.kr/e/2']
  const m = settled(member({ id: 'k', role: '다온', brief }), lines.join('\n'))
  expect(m.result).toBe(lines.join('\n'))
  const text = back(handBacks([m])).reports[0]!.result
  for (const word of ['내추럴 와인', '부르고뉴', '정비']) expect(text).toContain(word)
  expect(partOutcome(m)).toBe('found')
})

test('r3: tool names, ids and paths in a teammate\'s words are not cut by the host; keeping them from the person is the voice rule, and a page address reaches the lead whole', () => {
  const answer = 'fetch_page_text 호출로 보니 task-9be1c 기록은 ~/notes/wiki_log.md에 있고 개편은 금요일이에요. https://wiki.example.kr/news/re_design'
  const m = settled(member({ id: 't', role: '하린', brief: '이번 주 사내 위키 개편 소식 조사' }), answer, ['https://wiki.example.kr/news/re_design'])
  const handed = back(handBacks([m])).reports[0]!
  expect(handed.result).toBe(answer)
  expect(handed.sources).toEqual(['https://wiki.example.kr/news/re_design'])
  expect(COLLEAGUE_CORE_RULE).toContain('Nothing technical is ever shown: no tool or function names, ids, raw states or codes')
  expect(COLLEAGUE_CORE_RULE).toContain('a file is called by its name, never by its folder path')
})

test('r3 → stack-11: no item is dropped by wording: a right item worded unlike the job stays, with or without list marks', () => {
  const brief = '다음 달 대전 보드게임 모임 일정'
  const items = ['둔산동 보드게임카페에서 정기 모임이 있어요. https://board.example.kr/m/3', '다음 달 유성 온천 축제가 열려요. https://fest.example.kr/f/1', '카탄 좋아하는 사람들 토요일 번개, 은행동 카페예요. https://board.example.kr/m/8']
  for (const mark of ['', '- ', '1) ']) {
    const text = items.map(item => `${mark}${item}`).join('\n')
    expect(keptItems(brief, text)).toBe(text)
    const m = settled(member({ id: 'b', role: '세아', brief }), text)
    for (const word of ['둔산동', '카탄', '온천']) expect(m.result).toContain(word)
  }
  expect(keptItems(brief, '가나 행사\n다라 행사')).toBe('가나 행사\n다라 행사')
})
