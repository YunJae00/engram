import { beforeEach, expect, test, vi } from 'vitest'
import { firstFound, firstSearches, makerFirst, makerOf, mergedReport, reportData, searchWords, topicOf } from '../src/company-tools.js'
import type { MemberData, MemberFact, TeamMember } from '../src/delegated-tasks.js'
import { foundNothing } from '../src/team-hire-tools.js'

// c9b: the named team's thread (C3–C10, H5). Days are read against the run's week.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-17T03:00:00Z') }) })

const firsts = (brief: string, about = brief) => firstSearches({ brief, query: searchWords(brief, new Date(), about) }, about)

test('c9 fix 1: a job about a named product opens with the news search and the maker\'s own updates page, by its Latin name', () => {
  const slack = firsts('이번 주 슬랙 신기능 조사', '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘')
  expect(slack).toEqual([{ query: '슬랙 앱 새 기능 업데이트', news: true }, { query: 'Slack release notes 업데이트', maker: 'Slack' }])
  expect(firsts('지난주 피그마 업데이트 뭐 있었어?')[1]).toEqual({ query: 'Figma release notes 업데이트', maker: 'Figma' })
  // No period word: the job's words are searched as they are, not as news.
  expect(firsts('디스코드 새 기능')).toEqual([{ query: '디스코드 새 기능 업데이트' }, { query: 'Discord patch notes 업데이트', maker: 'Discord' }])
  // The person's own Latin name wins over the list, and a product off the list is searched by it.
  expect(makerOf('리니어', '경쟁사 리니어(Linear) 조사')).toEqual({ name: 'Linear', query: 'Linear changelog' })
  expect(firsts('이번 주 플로우잇(Flowit) 신기능 조사')[1]).toEqual({ query: 'Flowit changelog 업데이트', maker: 'Flowit' })
  // An unknown product gets the one search.
  expect(firsts('이번 주 모아보기 앱 신기능 조사')).toHaveLength(1)
  // Never two of the same words, never more than two first searches, never a relative time in the words.
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

test('c9 fix 1: a teammate who describes the results page is not shown saying it', () => {
  const parts = [
    member({ id: 'm1', role: '지민', topic: '노션', brief: '이번 주 노션 신기능 조사', data: { facts: [{ text: '노션은 11월 12일에 AI 회의록 요약을 냈어요.', url: 'https://www.notion.com/releases', site: '노션' }] } }),
    member({ id: 'm2', role: '서연', topic: '슬랙', data: { facts: [], nothing: {}, note: '슬랙은 검색 결과가 사용법이랑 다운로드 안내 글들뿐이었어요.' } }),
    member({ id: 'm3', role: '도윤', topic: '리니어', brief: '이번 주 리니어 신기능 조사', data: { facts: [], nothing: {}, note: '리니어도 검색에서 무관한 액추에이터나 다른 앱들만 나왔어요.' } }),
  ]
  const text = mergedReport(parts)
  expect(text).toContain('[노션](https://www.notion.com/releases)')
  expect(text).not.toMatch(/검색 결과가|검색에서 무관/u)
  for (const word of ['노션', '슬랙', '리니어', '지민', '서연', '도윤']) expect(text).toContain(word)
  // The record reads "안 잡히더라고요" as found-nothing too (c9 C10: the summary writer was refused for saying so).
  expect(foundNothing('이번 주 기준으로는 슬랙 신기능 관련 구체적인 소식이 안 잡히더라고요!')).toBe(true)
})

// c11a: the same results as the teammates now hand them back (TeamMember.data).
const fact = (text: string, url: string, site: string, date?: string): MemberFact => ({ text, url, site, ...(date ? { date } : {}) })
const C5_DATA: MemberData = { facts: [
  fact("제11회 대한민국 소프트웨어 대전 '소프트웨이브 2026', 코엑스(COEX) Hall A", 'https://www.coex.co.kr/exhibitions/sw2026/', '코엑스', '12월 2일(수)~4일(금)'),
  fact('AI 서밋 서울 2026, 그랜드 인터컨티넨탈', 'https://example.com/aisummit', 'example.com', '12월 9일(수)'),
  fact('클라우드 데이 서울, 코엑스', 'https://example.com/cloudday', 'example.com', '12월 16일(수)')] }
// This run's stored C5 and C6 members (stack8-67507b42, tasks.json), cut to what the path reads.
const C5_RESULT = '확인해 보니 다음 달 서울 IT 행사 일정은 이래요.\n\n- 12월 2일(수)~4일(금): 제11회 대한민국 소프트웨어 대전 \'소프트웨이브 2026\', 코엑스(COEX) Hall A — https://www.coex.co.kr/exhibitions/sw2026/\n- 12월 9일(수): AI 서밋 서울 2026, 그랜드 인터컨티넨탈 — https://example.com/aisummit\n- 12월 16일(수): 클라우드 데이 서울, 코엑스 — https://example.com/cloudday'
const C6_RESULT = '1. 12월 2일부터 4일까지, 코엑스에서 소프트웨이브 2026이 열려요! SW업계 신제품과 비즈니스 기회를 한자리에서 만나보세요!\n2. 일반 관람은 12월 3일, 4일이 딱 좋더라고요! 다음 달 서울 IT 트렌드, 소프트웨이브 2026에서 눈으로 확인해보세요!\n3. 올해 마지막 대형 SW 박람회, 소프트웨이브 2026이 코엑스 Hall A에서 기다리고 있더라고요! 놓치면 아쉬운 다음 달 IT 행사, 지금 일정 체크해보세요!'
const C6_ITEMS = C6_RESULT.split('\n').map(line => line.replace(/^\d\. /, ''))

test('c9 fix 2/3: C5 and C6 open with the thing, in two different ways, with no closing source sentence (c11a: structure)', async () => {
  const { handoffBrief } = await import('../src/company-tools.js')
  // c12a B1: assign names a plain hand-off's part from the person's job words (topicOf); the opener says who brought how many of it.
  const kim = member({ role: '지민', brief: '다음 달 서울 IT 행사 일정 정리', title: '다음 달 서울 IT 행사 일정 정리', topic: topicOf('다음 달 서울 IT 행사 일정 정리'), background: true, result: C5_RESULT, data: C5_DATA })
  const c5 = mergedReport([kim])
  const c5lead = c5.split('\n')[0]!
  // c13a (cause H; C5 judge on "…일정 3개를 찾아 왔어요"): no host count lead; the first line is the first item, with whose it is.
  // c16a r2: updated (pinned the old "(name)" tag on a one-part line): whose it is is the first line's subject, "<name>이/가 찾아보니 …".
  expect(c5lead).toMatch(/^- 지민이 찾아보니 .+ \[[^\]]+\]\(https:/u)
  expect(c5).not.toMatch(/\d개를|찾아 왔어요/u)
  // The teammate's own "…은 이래요." intro line is not an item; the three are, each with its link. BAR C5: 행사 and a date.
  expect(c5).not.toContain('확인해 보니')
  expect(c5.split('\n').filter(line => line.startsWith('- '))).toHaveLength(3)
  for (const f of C5_DATA.facts) expect(c5).toContain(`[${f.site}](${f.url})`)
  expect(c5).not.toContain('출처')
  // c13a: the host's rendering adds no words of its own (the BAR's "행사" is the writer's lead); who and a date are in the data.
  expect(c5).toMatch(/지민/); expect(c5).toMatch(/12월 2일/)

  const park = member({ id: 'm2', role: '서연', lookup: undefined, writer: true, background: true, brief: handoffBrief('홍보 문구 3개 뽑기', '지민', C5_RESULT, '다음 달 서울 IT 행사 일정 정리'), title: '홍보 문구 3개 뽑기', result: C6_RESULT, data: { facts: [], items: C6_ITEMS } })
  const c6 = mergedReport([park])
  // c12a B1: never the job title "홍보 문구 3개 뽑기(서연, …):". c13a (cause H): no host sentence on who made what from whose find;
  // BAR C6: three list lines, each the item exactly, then whose they are with the find's page.
  // c17c (cause S, C6): whose they are and whose find leads, closed by the find's pages, then the items; never a "(서연, …)" tag.
  expect(c6.split('\n')).toEqual(['서연이 지민이 찾은 서울 IT 행사 일정으로 홍보 문구를 만들었어요. [코엑스](https://www.coex.co.kr/exhibitions/sw2026/) · [example.com](https://example.com/aisummit)', ...C6_ITEMS.map((item, i) => `${i + 1}. ${item}`)])
  expect(c6).toMatch(/행사/)
  expect(c6).not.toMatch(/에서 나온 거예요|찾아보니|찾은 걸 따랐어요|으로 뽑았어요\./u)
  // Two teammates never open the same way.
  expect(c6.split('\n')[0]).not.toBe(c5lead)
  // A list job that brought one item shows it as one line with its link, not a list.
  const one = mergedReport([{ ...kim, data: { facts: [C5_DATA.facts[0]!] } }])
  expect(one.split('\n')).toHaveLength(1)
  // c16a r2: updated (pinned the old "(name)" tag on a one-part line): whose it is is the first line's subject, "<name>이/가 찾아보니 …".
  expect(one).toMatch(/^지민이 찾아보니 .+ \[코엑스\]\(https:\/\/www\.coex\.co\.kr\//u)
})

test('c9 fix 2: a writer\'s own closing line on where the facts came from is not shown (c11a: structure)', async () => {
  const { handoffBrief } = await import('../src/company-tools.js')
  const kim = '이번 주말 서울은 토요일 아침 영하 6도, 낮 2~6도에 대체로 맑대요. https://www.weather.go.kr/w/a'
  const brief = handoffBrief('주말 나들이 추천 문구 한 줄 써줘', '지민', kim, '이번 주말 서울 날씨 찾기')
  const answer = '```report\n' + JSON.stringify({ items: ['맑은 주말, 낮 2~6도면 짧은 한강 산책이 딱이에요!'], note: '지민이가 찾아준 이번 주말 서울 날씨 정보는 기상청에서 나온 거예요.' }) + '\n```'
  const park = member({ role: '서연', lookup: undefined, writer: true, background: true, brief })
  park.data = reportData(answer, park)!
  const h5 = mergedReport([park])
  // c13a (cause H): the line itself, then whose it is with the page of the find it was made from.
  // c17c (cause S): the attribution sentence with the find's page leads, then the line.
  expect(h5.split('\n')[1]).toBe('맑은 주말, 낮 2~6도면 짧은 한강 산책이 딱이에요!')
  expect(h5.split('\n')[0]).toMatch(/^서연이 지민이 찾은 서울 날씨로 .*만들었어요\. \[기상청\]\(https:\/\/www\.weather\.go\.kr\/w\/a\)$/)
  expect(h5).not.toMatch(/나온 거예요|지민이가 찾아준/u)
})

// --- c9b round 2 (Codex r1) ---
test('c9b r2 finding 1: any job about a named product opens with the maker\'s own page too, not only an updates job', () => {
  // Codex's repro: "이번 주 슬랙 가격 조사" ran one search with no period.
  expect(firsts('이번 주 슬랙 가격 조사')).toEqual([{ query: '슬랙 가격', news: true }, { query: 'Slack release notes 업데이트', maker: 'Slack' }])
  expect(firsts('노션 요금제 정리')).toEqual([{ query: '노션 요금제' }, { query: 'Notion releases 업데이트', maker: 'Notion' }])
  expect(firsts('플로우잇(Flowit) 가격 조사')[1]).toEqual({ query: 'Flowit changelog 업데이트', maker: 'Flowit' })
  // A bare Latin word names a maker only in an updates job, and an unknown product gets the one search.
  expect(firsts('이번 주 KOSPI 지수 조사')).toHaveLength(1)
  expect(firsts('이번 주 모아보기 앱 가격 조사')).toHaveLength(1)
  // The teammate is told to read the maker's page only when the part is about what the maker put out.
  const told = firstFound([{ query: '슬랙 가격', news: true, found: 'results for "a"' }, { query: 'Slack release notes', maker: 'Slack', found: 'x', own: true }])
  expect(told).toMatch(/When your part is about what Slack has put out or changed, read that one page/)
})

test('c9b r2 finding 2: C5 and C6 openers are said in each teammate\'s own stored voice (c11a: structure: a voice never changes what is shown)', async () => {
  const { handoffBrief } = await import('../src/company-tools.js')
  const kim = (voice?: string) => member({ role: '지민', brief: '다음 달 서울 IT 행사 일정 정리', title: '다음 달 서울 IT 행사 일정 정리', topic: topicOf('다음 달 서울 IT 행사 일정 정리'), background: true, result: C5_RESULT, data: C5_DATA, ...(voice ? { voice } : {}) })
  // c11a: no stock ending is forced on a teammate's lines; the same data reads the same in any voice.
  const plain = mergedReport([kim()])
  for (const voice of ['차분하고 또박또박', '밝고 시원시원하게', '담백하고 짧게', '사투리로']) expect(mergedReport([kim(voice)])).toBe(plain)
  // c16a r2: updated (pinned the old "(name)" tag on a one-part line): whose it is is the first line's subject, "<name>이/가 찾아보니 …".
  expect(plain.split('\n')[0]).toMatch(/^- 지민이 찾아보니 .+ \[/u)
  expect(plain).not.toMatch(/더라고요!|네요\./u)
  const park = (voice?: string) => member({ id: 'm2', role: '서연', ...(voice ? { voice } : {}), lookup: undefined, writer: true, background: true, brief: handoffBrief('홍보 문구 3개 뽑기', '지민', C5_RESULT, '다음 달 서울 IT 행사 일정 정리'), title: '홍보 문구 3개 뽑기', result: C6_RESULT, data: { facts: [], items: C6_ITEMS } })
  const c6 = mergedReport([park('밝고 시원시원하게')])
  expect(c6).toBe(mergedReport([park()]))
  expect(c6.split('\n')[0]).toMatch(/^서연이 지민이 찾은 서울 IT 행사 일정으로 홍보 문구를 만들었어요\. \[코엑스\]\(https:\/\/www\.coex\.co\.kr\//u)
  expect(c6.match(/^\d\. /gm)).toHaveLength(3)
  // The deliverable's items are copied exactly: a voice never rewrites them.
  expect(c6.split('\n').slice(1)).toEqual(C6_ITEMS.map((item, i) => `${i + 1}. ${item}`))
})

test('c9b r3: the writer\'s own C5 opener is said in the teammate\'s stored voice, not passed through plain (c11a: structure)', async () => {
  const { checkedReport } = await import('../src/company-tools.js')
  const seo = (voice: string) => member({ role: '서연', voice, brief: '서울 IT 행사 일정 정리', lookup: true, result: '12월 2일 행사 A https://example.com/a', sources: ['https://example.com/a'], data: { facts: [fact('12월 2일 행사 A', 'https://example.com/a', 'example.com')] } })
  const message = (text: string) => JSON.stringify({ message: text, kept: ['f1'] })
  // A line led by the teammate's name and a colon is refused, whatever the voice.
  for (const voice of ['밝고 시원시원하게', '담백하고 짧게']) expect(checkedReport(message('서연: 12월 2일 행사 A가 열려요.\n\n- 12월 2일 행사 A [출처](https://example.com/a)'), [seo(voice)])).toBeUndefined()
  // A sentence naming the teammate is kept as the writer wrote it, its link renamed by the site, never 출처, in any voice.
  const ok = message('서연이 알아보니 12월 2일에 행사 A가 열려요. [출처](https://example.com/a)')
  const out = checkedReport(ok, [seo('차분하고 또박또박')])
  expect(out).toBe('서연이 알아보니 12월 2일에 행사 A가 열려요. [example.com](https://example.com/a)')
  expect(checkedReport(ok, [seo('밝고 시원시원하게')])).toBe(out)
})
