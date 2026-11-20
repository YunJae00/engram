import { expect, test } from 'vitest'
import { createBot } from '../src/bots.js'
import { askedCount, employeeWriteBack, handBacks, handoffBrief, partOutcome, teamRecord, teamSummary, topicOf } from '../src/company-tools.js'
import { datedText, type TeamMember } from '../src/delegated-tasks.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-11-18T03:00:00Z')
const at = new Date(NOW.getTime() - 5_000).toISOString()
const member = (over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'role' | 'brief'>): TeamMember => ({ parentId: null, depth: 1, botId: `bot-${over.id}`, lookup: true, background: true, state: 'hired', sessionKey: `s-${over.id}`, hiredAt: at, ...over })
const settled = (m: TeamMember, answer: string, sources: string[] = [], more: { read?: string; timedOut?: boolean } = {}): TeamMember => {
  settleMember(m, { answer, sources, ...more }, NOW.toISOString(), true)
  return m
}
interface Back { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
const back = (members: TeamMember[]): Back => JSON.parse(handBacks(members)) as Back
const count = (text: string, piece: string): number => text.split(piece).length - 1

const PIER_PAGE = 'https://pier.example.kr/notice'
test('A2: a part that stopped mid-way reaches the lead as its own words with the page it was looking at, beside the finished parts; the host writes no line for it', () => {
  const yeosu = settled(member({ id: 'm1', role: '민준', brief: '이번 달 여수 여객선 시간표 변경 조사', topic: '여수' }), '여수는 11월 6일부터 첫 배가 7시 40분이에요. https://ferry.example.kr/yeosu/11234', ['https://ferry.example.kr/yeosu/11234'])
  const mokpo = settled(member({ id: 'm2', role: '지아', brief: '이번 달 목포 여객선 시간표 변경 조사', topic: '목포' }), '목포 터미널 공지를 보고 있었는데', [PIER_PAGE])
  const tongyeong = settled(member({ id: 'm3', role: '하율', brief: '이번 달 통영 여객선 시간표 변경 조사', topic: '통영' }), '통영은 11월 3일부터 욕지도행이 한 편 늘었어요. https://ferry.example.kr/tongyeong/2026', ['https://ferry.example.kr/tongyeong/2026'])
  const out = back([yeosu, mokpo, tongyeong])
  expect(out.reports.map(r => r.who)).toEqual(['민준', '지아', '하율'])
  expect(out.reports[1]).toEqual({ who: '지아', part: '목포', state: 'done', result: '목포 터미널 공지를 보고 있었는데', sources: [PIER_PAGE] })
  expect(mokpo.review).toBeUndefined()
  expect([yeosu.review?.ok, tongyeong.review?.ok]).toEqual([true, true])
  expect(count(JSON.stringify(out.reports), '지아')).toBe(1)
  expect(partOutcome({ ...mokpo, unfinished: true })).toBe('unfinished')
  expect(out.note).toContain('Say plainly which part failed or is missing.')
})

test('B1: a hand-off reaches the lead as who found what and who made what from it, with no job title in it', () => {
  const find = '서면 골목 밀면집이 줄 서는 곳이에요. https://busan.example.kr/eat/77'
  const giver = settled(member({ id: 'm1', role: '하율', brief: '이번 주 부산 맛집 찾아봐', title: '이번 주 부산 맛집 찾기', topic: topicOf('이번 주 부산 맛집 찾아봐'), then: { botId: 'bot-m2', who: '지아', brief: '소개 글 두 편 써줘' } }), find, ['https://busan.example.kr/eat/77'])
  const lines = '시원한 육수 한 모금에 여름이 물러가요\n줄 서도 아깝지 않은 한 그릇'
  const writer = settled(member({ id: 'm2', role: '지아', lookup: undefined, writer: true, title: '소개 글 두 편 쓰기', brief: handoffBrief('소개 글 두 편 써줘', '하율', giver.result!, giver.brief) }), lines)
  const out = back([giver, writer])
  expect(out.reports).toEqual([{ who: '하율', part: '부산 맛집', state: 'done', result: find, sources: ['https://busan.example.kr/eat/77'] }, { who: '지아', state: 'done', result: lines }])
  expect(JSON.stringify(out.reports)).not.toMatch(/쓰기|찾기/)
  expect(['다음 달 대전 보드게임 모임 일정', '이번 주 광주 날씨 알아봐', '지난달 판교 밋업 정리'].map(topicOf)).toEqual(['대전 보드게임 모임 일정', '광주 날씨', '판교 밋업'])
})

test('B2: a date a teammate wrote once is there once, in the hand-off brief and in what the lead is handed, whatever wording the text uses', () => {
  const fireworks = { text: '부산 불꽃축제가 11월 8일 저녁에 열려요.', url: 'https://fest.example.kr/fire', date: '11월 8일' }
  const range = { text: '대전 보드게임 페어가 11월 3일부터 5일까지 열려요.', url: 'https://game.example.kr/fair', date: '11월 3~5일' }
  const bare = { text: '청주 북페어가 열려요.', url: 'https://book.example.kr/fair', date: '11월 15일' }
  for (const f of [fireworks, range]) expect(datedText(f)).toBe(f.text)
  expect(datedText(bare)).toBe('청주 북페어가 열려요 (11월 15일).')
  const answer = [fireworks, range, bare].map(f => `${datedText(f)} ${f.url}`).join('\n')
  const m = settled(member({ id: 'm1', role: '도윤', brief: '11월 축제 목록', topic: '11월 축제' }), answer)
  expect(m.result).toBe(answer)
  const shown = back([m]).reports[0]!.result
  for (const date of ['11월 8일', '11월 3', '11월 15일']) expect(shown.split(date)).toHaveLength(2)
  const brief = handoffBrief('홍보 문구 하나 써줘', '도윤', m.result!, m.brief)
  for (const date of ['11월 8일', '11월 3', '11월 15일']) expect(brief.split(date)).toHaveLength(2)
})

test('B3: a page that lists many, written beside the single items, stays in the teammate\'s result with its own address, so the lead can say where the whole list is', () => {
  const brief = '다음 달 대전 보드게임 모임 일정'
  const answer = ['- 12월 6일 둔산동에서 보드게임 모임이 열려요. https://board.example.kr/daejeon/1206', '- 12월 27일 유성에서 보드게임 모임이 열려요. https://board.example.kr/daejeon/1227', '- 나머지 모임은 카페 일정 페이지에 모여 있어요. https://board.example.kr/daejeon/schedule'].join('\n')
  const m = settled(member({ id: 'm1', role: '서아', brief, topic: topicOf(brief) }), answer, ['https://board.example.kr/daejeon/schedule'])
  expect(m.result).toBe(answer)
  const handed = back([m]).reports[0]!
  expect(handed.result.split('\n')).toHaveLength(3)
  expect(handed.result).toContain('https://board.example.kr/daejeon/schedule')
  expect(handed.part).toBe('대전 보드게임 모임 일정')
  expect(m.review).toEqual({ ok: true, note: 'auto: sourced lookup' })
})

test('B4: the record line holds the job and one short clause; the summary prompt carries the job lines only', async () => {
  const paths = await initVault(await tmpVaultRoot('c12a-record'))
  const bot = await createBot(paths, { name: '서아' })
  const data = { facts: [{ text: '12월 6일 둔산동에서 보드게임 모임이 열려요.', url: 'https://a.example/1', site: 'a', name: '둔산동 보드게임 모임' }, { text: '12월 20일 유성에서 모임이 열려요.', url: 'https://a.example/2', site: 'a' }, { text: 'c', url: 'https://a.example/3', site: 'a' }, { text: 'd', url: 'https://a.example/4', site: 'a' }] }
  await employeeWriteBack(paths, { botId: bot.id, brief: '다음 달 대전 보드게임 모임 일정', result: '12월 6일 둔산동에서 보드게임 모임이 열려요. — https://a.example/1', title: '다음 달 대전 보드게임 모임 일정', data }, NOW)
  await employeeWriteBack(paths, { botId: bot.id, brief: '인스타 문구 2개 써줘', result: '1. 가\n2. 나', title: '인스타 문구 2개 쓰기', data: { facts: [], items: ['가', '나'] } }, NOW)
  const lines = (await teamRecord(paths)).facts.map(f => f.text)
  expect(lines).toEqual([`다음 달 대전 보드게임 모임 일정 → 둔산동 보드게임 모임 등 4개 찾았어요 (서아, 2026-11-18)`, `인스타 문구 2개 쓰기 → 2개 써 왔어요 (서아, 2026-11-18)`])
  const asked: string[] = []
  await teamSummary(paths, { bots: [bot], message: '이번 주에 팀이 뭐 했어?', write: async prompt => { asked.push(prompt); return '' }, now: NOW })
  expect(asked[0]).toContain('never with details of what was found')
  expect(asked[0]).not.toMatch(/12월 6일|유성/)
})

test('A1 contract: a teammate cut off while it had only said what it was about to do hands back what it read, with the page, marked as read and as stopped at its time', () => {
  const read = '목포 터미널 공지: 12월부터 홍도행 막배 15시 30분 https://pier.example.kr/notice/1'
  const m = settled(member({ id: 'm1', role: '지아', brief: '이번 달 목포 여객선 시간표 변경 조사' }), '공지 게시판을 확인해 볼게요.', [PIER_PAGE], { read, timedOut: true })
  expect(m.state).toBe('done')
  expect(m.read).toBe(true)
  expect(m.result).toBe(`${read}\n(시간 한도에서 멈춤: 여기까지 찾은 내용)`)
  expect(m.result).not.toContain('확인해 볼게요')
  expect(back([m]).reports[0]).toMatchObject({ who: '지아', result: m.result, sources: [PIER_PAGE] })
})

test('r2 B2: a model number or a price sharing a digit with the date does not count as the date being stated', () => {
  expect(datedText({ text: '아이폰 18 가격은 11만 원이에요.', date: '11월 18일' })).toBe('아이폰 18 가격은 11만 원이에요 (11월 18일).')
  expect(datedText({ text: '갤럭시 S27 사전예약은 27만 명이 했어요.', date: '3월 27일' })).toBe('갤럭시 S27 사전예약은 27만 명이 했어요 (3월 27일).')
  expect(datedText({ text: '맥북 14인치 13 대가 남았어요.', date: '2027.1.13' })).toBe('맥북 14인치 13 대가 남았어요 (2027.1.13).')
  for (const text of ['3월 27일 오후에 문을 열어요.', '2027.1.13에 공개돼요.', '4월 2~6일 전시가 열려요.']) expect(datedText({ text, date: text.startsWith('2027') ? '2027년 1월 13일' : text.startsWith('3월') ? '3월 27일' : '4월 2일~6일' })).toBe(text)
})

test('r2 B3: a lone page that lists many is handed back as the teammate wrote it, whatever the ask says; a counted ask is still read as its count', () => {
  const line = '광주 독서 모임 게시판에 이번 겨울 모임이 여럿 올라와 있어요. https://read.example.kr/gwangju/board'
  for (const [brief, asked] of [['광주 독서 모임 세 가지만 추려줘', 3], ['광주에서 갈 만한 독서 모임 하나 찾아봐', 0]] as const) {
    const m = settled(member({ id: 'g', role: '하람', brief }), line, ['https://read.example.kr/gwangju/board'])
    expect(askedCount(brief)).toBe(asked)
    expect(m.result).toBe(line)
    expect(back([m]).reports[0]!.result).toBe(line)
    expect(partOutcome(m)).toBe('found')
  }
})

test('r2/r3 B3: in the team record a page that lists many, or the rest of one, is never counted as an item found', async () => {
  const paths = await initVault(await tmpVaultRoot('c12a-listing'))
  const bot = await createBot(paths, { name: '나래' })
  const page = { text: '울산 러닝 크루 페이지에 모임 네 개가 있어요.', url: 'https://run.example.kr/ulsan', site: '런크루', listing: true as const }
  const other = { text: '포항 러닝 크루 목록에 모임이 여럿 있어요.', url: 'https://run.example.kr/pohang', site: '런크루', listing: true as const, rest: true as const }
  const one = { text: '1월 9일 태화강에서 저녁 러닝이 있어요.', url: 'https://run.example.kr/ulsan/0109', site: '런크루', date: '1월 9일', name: '태화강 저녁 러닝' }
  await employeeWriteBack(paths, { botId: bot.id, brief: '울산 러닝 모임', result: one.text, title: '울산 러닝 모임', data: { facts: [one, page, other] } }, NOW)
  await employeeWriteBack(paths, { botId: bot.id, brief: '포항 러닝 모임', result: page.text, title: '포항 러닝 모임', data: { facts: [page] } }, NOW)
  expect((await teamRecord(paths)).facts.map(f => f.text)).toEqual(['울산 러닝 모임 → 태화강 저녁 러닝을 찾았어요 (나래, 2026-11-18)', '포항 러닝 모임 → 찾았어요 (나래, 2026-11-18)'])
})

test('r3 B2: a date is matched as a date: a clock time, a word about now or a month/day swap does not hide it', () => {
  expect(datedText({ text: '사진전 개막식은 오후 3시 12분에 해요.', date: '3월 12일' })).toBe('사진전 개막식은 오후 3시 12분에 해요 (3월 12일).')
  expect(datedText({ text: '행사가 오전 9시 25분에 시작해요.', date: '9월 25일' })).toBe('행사가 오전 9시 25분에 시작해요 (9월 25일).')
  expect(datedText({ text: '오늘 확인해 보니 재즈 공연 표가 남아 있어요.', date: '1월 30일' })).toBe('오늘 확인해 보니 재즈 공연 표가 남아 있어요 (1월 30일).')
  expect(datedText({ text: '이번 주말에 플리마켓이 열려요.', date: '5월 17일' })).toBe('이번 주말에 플리마켓이 열려요 (5월 17일).')
  expect(datedText({ text: '6월 4일에 접수가 끝나요.', date: '4월 6일' })).toBe('6월 4일에 접수가 끝나요 (4월 6일).')
  for (const [text, date] of [['수영 대회는 8월 2일부터 4일까지 해요.', '8월 2~4일'], ['공개일은 2027.1.13.', '2027년 1월 13일'], ['Opens Mar 5 in Busan.', '3월 5일'], ['접수 마감은 7/21이에요.', '7월 21일'], ['10월 3일 오후 2시에 열려요.', '10월 3일']] as const) expect(datedText({ text, date })).toBe(text)
})

