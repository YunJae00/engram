import { expect, test } from 'vitest'
import { createBot } from '../src/bots.js'
import { checkedReport, employeeWriteBack, handoffBrief, itemsPrompt, keptReportPrompt, kindChecked, listingPages, mergedReport, reportCheck, reportData, reportPrompt, setReportLog, teamRecord, teamSummary, topicOf, withItems, writtenReport } from '../src/company-tools.js'
import { datedText, type TeamMember } from '../src/delegated-tasks.js'
import { settleMember } from '../src/team-hire-tools.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// c12a: the data contract closed (a part with nothing to show is the host's line), and person-facing text made from data, never from the
// job title or a date field put before a text that already says it. Wordings here are not the harness's.
const NOW = new Date('2026-11-18T03:00:00Z')
const at = new Date(NOW.getTime() - 5_000).toISOString()
const block = (json: unknown): string => `\`\`\`report\n${JSON.stringify(json)}\n\`\`\``
const member = (over: Partial<TeamMember> & Pick<TeamMember, 'id' | 'role' | 'brief'>): TeamMember => ({ parentId: null, depth: 1, botId: `bot-${over.id}`, lookup: true, background: true, state: 'hired', sessionKey: `s-${over.id}`, hiredAt: at, ...over })
const settled = (m: TeamMember, answer: string, sources: string[] = []): TeamMember => {
  settleMember(m, { answer, sources, report: reportData(answer, m, sources, true) ?? null }, NOW.toISOString(), true)
  return m
}
const links = (text: string): string[] => [...text.matchAll(/\]\((https?:[^)]+)\)/g)].map(one => one[1]!)

// A2: 지아 read LINE's page and ended with no report (cut, no block); 민준 and 하율 brought data.
const LINE_PAGE = 'https://linecorp.com/ko/pr/news'
function split(): TeamMember[] {
  const kakao = settled(member({ id: 'm1', role: '민준', brief: '이번 달 카카오톡 업데이트 조사', topic: '카카오톡' }), block({ facts: [{ text: '카카오톡에 채팅방 폴더 정리 기능이 생겼어요.', url: 'https://www.kakaocorp.com/page/detail/11234', date: '11월 6일' }] }))
  const line = settled(member({ id: 'm2', role: '지아', brief: '이번 달 라인 업데이트 조사', topic: '라인' }), '라인 공지사항을 보고 있었는데', [LINE_PAGE])
  const tele = settled(member({ id: 'm3', role: '하율', brief: '이번 달 텔레그램 업데이트 조사', topic: '텔레그램' }), block({ facts: [{ text: '텔레그램이 그룹 통화 인원을 늘렸어요.', url: 'https://telegram.org/blog/group-calls-2026', date: '11월 3일' }] }))
  return [kakao, line, tele]
}
const ASK = '카카오톡 / 라인 / 텔레그램 이번 달 업데이트 민준, 지아, 하율한테 나눠서 알아봐'

test('A2: a part with no data is the host\'s own line with the page it looked at; the writer is not given it and may not say it', async () => {
  const parts = split()
  expect(parts[1]!.data).toBeUndefined()
  const prompt = reportPrompt(ASK, parts, new Map(), { now: NOW })
  // The writer never gets the part to describe, and is told to leave that teammate out.
  expect(prompt).not.toContain('"name":"지아"')
  expect(prompt).not.toContain('"missing"')
  expect(prompt).toContain('Do not mention 지아 at all')
  const kept = ['f1', 'f2']
  const good = '이번 달엔 카카오톡이랑 텔레그램에 새 기능이 나왔어요.\n\n카카오톡은 민준이 봤는데 채팅방 폴더 정리 기능이 생겼어요. [카카오](https://www.kakaocorp.com/page/detail/11234)\n\n텔레그램은 하율이 봤는데 그룹 통화 인원이 늘었어요. [텔레그램](https://telegram.org/blog/group-calls-2026)'
  // "라인은 새 소식이 없어요" with no link: the writer invented a finding for a part that has none. Refused, by the name, not the words.
  const invented = good.replace('\n\n텔레그램은', '\n\n라인은 지아가 봤는데 새 소식이 없어요.\n\n텔레그램은')
  expect(reportCheck(JSON.stringify({ message: invented, kept }), parts)).toEqual({ refused: 'missing-said' })
  const lines: string[] = []
  setReportLog(line => lines.push(line))
  try {
    const refused = await writtenReport({ ask: ASK, members: parts, write: async () => JSON.stringify({ message: invented, kept }), timeoutMs: 500, now: NOW })
    expect(refused).toBe(mergedReport(parts))
    // c13a: each part's outcome is on the line too.
    expect(lines.at(-1)).toMatch(/^writer=refused:missing-said ms=\d+ parts=3 missing=1 outcomes=민준:found,지아:unfinished,하율:found$/)
    const shown = await writtenReport({ ask: ASK, members: parts, write: async () => JSON.stringify({ message: good, kept }), timeoutMs: 500, now: NOW })
    expect(lines.at(-1)).toMatch(/^writer=accepted ms=\d+/)
    // The writer's message, then the host's rule-7 line for 지아 with where they looked. All three parts are linked.
    expect(shown.split('\n\n').at(-1)).toBe(`라인(지아): 이번엔 끝까지 못 봤어요. 보던 곳은 [linecorp.com](${LINE_PAGE})`)
    expect(shown.match(/지아/g)).toHaveLength(1)
    expect(links(shown)).toEqual(['https://www.kakaocorp.com/page/detail/11234', 'https://telegram.org/blog/group-calls-2026', LINE_PAGE])
    // Late and absent writers are logged too.
    await writtenReport({ ask: ASK, members: parts, write: () => new Promise(() => {}), timeoutMs: 20, now: NOW })
    expect(lines.at(-1)).toMatch(/^writer=late /)
    await writtenReport({ ask: ASK, members: parts, now: NOW })
    expect(lines.at(-1)).toMatch(/^writer=none /)
  } finally { setReportLog(() => undefined) }
})

test('B1: a hand-off\'s fallback leads with who made what from whose find, never a job title head', () => {
  const giver = settled(member({ id: 'm1', role: '하율', brief: '이번 주 부산 맛집 찾아봐', title: '이번 주 부산 맛집 찾기', topic: topicOf('이번 주 부산 맛집 찾아봐'), then: { botId: 'bot-m2', who: '지아', brief: '인스타 문구 2개 써줘' } }), block({ facts: [{ text: '해운대 전포 돼지국밥집이 줄 서는 곳이에요.', url: 'https://busan.example.kr/eat/77' }] }))
  const writer = settled(member({ id: 'm2', role: '지아', lookup: undefined, writer: true, title: '인스타 문구 2개 쓰기', brief: handoffBrief('인스타 문구 2개 써줘', '하율', giver.result!, giver.brief) }), block({ items: ['국물 한 숟갈에 부산이 다 들어 있어요', '줄 서도 아깝지 않은 한 그릇'] }))
  const shown = mergedReport([giver, writer])
  expect(shown).not.toMatch(/쓰기|찾기|인스타 문구 2개/)
  // c13a (cause H): the items first, then whose they are with the page they were made from; no host sentence about who made what.
  expect(shown.split('\n')).toEqual(['1. 국물 한 숟갈에 부산이 다 들어 있어요', '2. 줄 서도 아깝지 않은 한 그릇', '(지아, 하율이 찾은 부산 맛집) [busan.example.kr](https://busan.example.kr/eat/77)'])
  // The giver's own bubble (posted before the writer finishes): no job title either.
  expect(mergedReport([giver])).toBe('해운대 전포 돼지국밥집이 줄 서는 곳이에요. (하율) [busan.example.kr](https://busan.example.kr/eat/77)')
  // A part's name from the person's words when the lead gave none, without its time or its doing word.
  expect(['다음 달 대전 보드게임 모임 일정', '이번 주 광주 날씨 알아봐', '지난달 판교 밋업 정리'].map(topicOf)).toEqual(['대전 보드게임 모임 일정', '광주 날씨', '판교 밋업'])
})

test('B2: a date is shown once, in the fallback, the hand-off brief and the writer\'s data, whatever wording the text uses', async () => {
  const fireworks = { text: '부산 불꽃축제가 11월 8일 저녁에 열려요.', url: 'https://fest.example.kr/fire', date: '11월 8일' }
  const range = { text: '대전 보드게임 페어가 11월 3일부터 5일까지 열려요.', url: 'https://game.example.kr/fair', date: '11월 3~5일' }
  const bare = { text: '청주 북페어가 열려요.', url: 'https://book.example.kr/fair', date: '11월 15일' }
  for (const f of [fireworks, range]) expect(datedText(f)).toBe(f.text)
  expect(datedText(bare)).toBe('청주 북페어가 열려요 (11월 15일).')
  const m = settled(member({ id: 'm1', role: '도윤', brief: '11월 축제 목록', topic: '11월 축제' }), block({ facts: [fireworks, range, bare] }))
  const shown = mergedReport([m])
  for (const date of ['11월 8일', '11월 3', '11월 15일']) expect(shown.split(date)).toHaveLength(2)
  const brief = handoffBrief('홍보 문구 하나 써줘', '도윤', m.result!, m.brief)
  for (const date of ['11월 8일', '11월 3', '11월 15일']) expect(brief.split(date)).toHaveLength(2)
  const data = JSON.parse(reportPrompt('축제 정리해줘', [m]).split('Data: ')[1]!) as { facts: { text: string; date?: string }[] }[]
  expect(data[0]!.facts.map(f => f.text)).toEqual([fireworks.text, range.text, '청주 북페어가 열려요 (11월 15일).'])
  expect(data[0]!.facts.every(f => f.date === undefined)).toBe(true)
})

test('B3: a listing page is flagged by meaning, taken apart into items when time allows, else shown labeled and never as an item', async () => {
  const brief = '다음 달 대전 보드게임 모임 일정'
  const listing = { text: '대전 보드게임 카페 모임 일정 페이지에 다음 달 모임 여러 개가 올라와 있어요.', url: 'https://board.example.kr/daejeon/schedule', site: 'board.example.kr' }
  const yearOnly = { text: '대전 보드게임 페스타 2026이 열려요.', url: 'https://festa.example.kr/2026', site: 'festa.example.kr', date: '2026' }
  const prompts: string[] = []
  const checked = await kindChecked({ facts: [listing, yearOnly] }, brief, async prompt => { prompts.push(prompt); return '{"keep":[1,2],"lists":[1,2],"names":{"1":"보드게임 카페 모임","2":"보드게임 페스타"}}' })
  // One call, the same one that judges kind; no word list in it.
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toContain('"lists"')
  expect(checked!.facts.map(f => [f.listing, f.name])).toEqual([[true, '보드게임 카페 모임'], [true, '보드게임 페스타']])
  expect(listingPages(checked)).toEqual([listing.url, yearOnly.url])
  expect(itemsPrompt(listingPages(checked))).toContain(listing.url)
  // The extra round brings two dated items: they take the pages' place, one per line in the fallback.
  const more = reportData(block({ facts: [{ text: '12월 6일 둔산동에서 보드게임 모임이 열려요.', url: 'https://board.example.kr/daejeon/1206', date: '12월 6일' }, { text: '12월 20일 유성에서 보드게임 모임이 열려요.', url: 'https://board.example.kr/daejeon/1220', date: '12월 20일' }] }), { brief })
  const whole = withItems(checked!, more)
  // round 3: the pages are never taken out; they follow the items as where the full list is.
  expect(whole.facts.map(f => [f.url, f.rest])).toEqual([['https://board.example.kr/daejeon/1206', undefined], ['https://board.example.kr/daejeon/1220', undefined], [listing.url, true], [yearOnly.url, true]])
  const m = member({ id: 'm1', role: '서아', brief, topic: topicOf(brief), state: 'done', data: whole })
  expect(mergedReport([m]).split('\n')).toEqual(['- 12월 6일 둔산동에서 보드게임 모임이 열려요. (서아) [board.example.kr](https://board.example.kr/daejeon/1206)', '- 12월 20일 유성에서 보드게임 모임이 열려요. [board.example.kr](https://board.example.kr/daejeon/1220)', '전체 목록은 여기 있어요. [board.example.kr](https://board.example.kr/daejeon/schedule) · [festa.example.kr](https://festa.example.kr/2026)'])
  // No time left (no extra round): the listing stays, labeled as not taken apart, never as an item of the list.
  const as = member({ id: 'm1', role: '서아', brief, state: 'done', data: { facts: [checked!.facts[0]!] } })
  expect(mergedReport([as])).toMatch(/여러 개가 올라와 있어요\. 여러 건이 한 페이지에 모여 있어요\. \(서아\) \[/)
  expect(reportPrompt(brief, [as])).toContain('"listPage":true')
  // A writer message that runs one teammate's two items and links into one line is refused (link positions, not words).
  const run = JSON.stringify({ message: '서아가 찾았어요. 12월 6일 둔산동 모임 [a](https://board.example.kr/daejeon/1206), 12월 20일 유성 모임 [b](https://board.example.kr/daejeon/1220)', kept: ['f1', 'f2'] })
  expect(reportCheck(run, [m])).toEqual({ refused: 'one-line' })
  const apart = JSON.stringify({ message: '서아가 찾았어요.\n- 12월 6일 둔산동 모임 [a](https://board.example.kr/daejeon/1206)\n- 12월 20일 유성 모임 [b](https://board.example.kr/daejeon/1220)', kept: ['f1', 'f2'] })
  expect(checkedReport(apart, [m])).toBeDefined()
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

test('A1 contract: the stand-in report is written under the same rule from what was read', () => {
  const prompt = keptReportPrompt('이번 달 라인 업데이트 조사', ['라인 공지: 앨범 화질 개선 https://linecorp.com/ko/pr/news/1'])
  expect(prompt).toContain('```report')
  expect(prompt).toContain('https://linecorp.com/ko/pr/news/1')
  expect(prompt).toContain('이번 달 라인 업데이트 조사')
})

// --- c12a round 2 (Codex r1). Wordings are not the harness's. ---

test('r2 B2: a model number or a price sharing a digit with the date does not count as the date being stated', () => {
  expect(datedText({ text: '아이폰 18 가격은 11만 원이에요.', date: '11월 18일' })).toBe('아이폰 18 가격은 11만 원이에요 (11월 18일).')
  expect(datedText({ text: '갤럭시 S27 사전예약은 27만 명이 했어요.', date: '3월 27일' })).toBe('갤럭시 S27 사전예약은 27만 명이 했어요 (3월 27일).')
  expect(datedText({ text: '맥북 14인치 13 대가 남았어요.', date: '2027.1.13' })).toBe('맥북 14인치 13 대가 남았어요 (2027.1.13).')
  // Stated as a date in any form: shown once.
  for (const text of ['3월 27일 오후에 문을 열어요.', '2027.1.13에 공개돼요.', '4월 2~6일 전시가 열려요.']) expect(datedText({ text, date: text.startsWith('2027') ? '2027년 1월 13일' : text.startsWith('3월') ? '3월 27일' : '4월 2일~6일' })).toBe(text)
})

test('r2 B3: one fact is always checked by meaning, whatever the ask says; a counted ask with no list word still gets a lone listing page labeled', async () => {
  const page = { text: '광주 독서 모임 게시판에 이번 겨울 모임이 여럿 올라와 있어요.', url: 'https://read.example.kr/gwangju/board', site: '책모임' }
  for (const brief of ['광주 독서 모임 두 개만 골라줘', '광주에서 갈 만한 독서 모임 하나 찾아봐']) {
    const prompts: string[] = []
    const checked = await kindChecked({ facts: [page] }, brief, async prompt => { prompts.push(prompt); return '{"keep":[1],"lists":[1]}' })
    expect(prompts).toHaveLength(1)
    expect(listingPages(checked)).toEqual([page.url])
    const m = member({ id: 'g', role: '하람', brief, state: 'done', data: checked! })
    expect(mergedReport([m])).toContain('여러 건이 한 페이지에 모여 있어요.')
  }
})

test('r2/r3 B3: a round that takes only part of a listing page, even one claiming the page whole, never drops the page or its label of the rest', () => {
  const page = { text: '울산 러닝 크루 페이지에 모임 네 개가 있어요.', url: 'https://run.example.kr/ulsan', site: '런크루', listing: true as const }
  const other = { text: '포항 러닝 크루 목록에 모임이 여럿 있어요.', url: 'https://run.example.kr/pohang', site: '런크루', listing: true as const }
  const one = { text: '1월 9일 태화강에서 저녁 러닝이 있어요.', url: 'https://run.example.kr/ulsan/0109', site: '런크루', date: '1월 9일' }
  // The teammate's own claim (an unknown "whole" field) is not data the host acts on.
  for (const extra of [{}, { whole: [page.url, other.url] }]) {
    const more = reportData(block({ facts: [one], ...extra }), { brief: '울산 러닝 모임' })
    const data = withItems({ facts: [page, other] }, more)
    expect(data.facts.map(f => [f.url, f.rest])).toEqual([[one.url, undefined], [page.url, true], [other.url, true]])
    const shown = mergedReport([member({ id: 'u', role: '나래', brief: '울산 러닝 모임', state: 'done', data })]).split('\n')
    expect(shown).toEqual(['1월 9일 태화강에서 저녁 러닝이 있어요. (나래) [런크루](https://run.example.kr/ulsan/0109)', '전체 목록은 여기 있어요. [런크루](https://run.example.kr/ulsan) · [런크루](https://run.example.kr/pohang)'])
  }
  // A round that gave nothing leaves the pages labeled as not taken apart.
  expect(withItems({ facts: [page] }, undefined).facts).toEqual([page])
  expect(mergedReport([member({ id: 'u', role: '나래', brief: '울산 러닝 모임', state: 'done', data: { facts: [page] } })])).toContain('여러 건이 한 페이지에 모여 있어요.')
})

// --- c12a round 3 (Codex r2). Wordings are not the harness's. ---

test('r3 B2: a date is matched as a date: a clock time, a word about now or a month/day swap does not hide it', () => {
  // Clock time sharing the date's numbers.
  expect(datedText({ text: '사진전 개막식은 오후 3시 12분에 해요.', date: '3월 12일' })).toBe('사진전 개막식은 오후 3시 12분에 해요 (3월 12일).')
  expect(datedText({ text: '행사가 오전 9시 25분에 시작해요.', date: '9월 25일' })).toBe('행사가 오전 9시 25분에 시작해요 (9월 25일).')
  // A word about now is not the event's day.
  expect(datedText({ text: '오늘 확인해 보니 재즈 공연 표가 남아 있어요.', date: '1월 30일' })).toBe('오늘 확인해 보니 재즈 공연 표가 남아 있어요 (1월 30일).')
  expect(datedText({ text: '이번 주말에 플리마켓이 열려요.', date: '5월 17일' })).toBe('이번 주말에 플리마켓이 열려요 (5월 17일).')
  // The same numbers in the other roles (6월 4일 vs 4월 6일).
  expect(datedText({ text: '6월 4일에 접수가 끝나요.', date: '4월 6일' })).toBe('6월 4일에 접수가 끝나요 (4월 6일).')
  // Stated as a date in any form: once.
  for (const [text, date] of [['수영 대회는 8월 2일부터 4일까지 해요.', '8월 2~4일'], ['공개일은 2027.1.13.', '2027년 1월 13일'], ['Opens Mar 5 in Busan.', '3월 5일'], ['접수 마감은 7/21이에요.', '7월 21일'], ['10월 3일 오후 2시에 열려요.', '10월 3일']] as const) expect(datedText({ text, date })).toBe(text)
})

