import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { plainPage } from '../src/main/plain-page.js'
import { askedCount, calendarDates, cometTools, datedWithYear, inPeriod, newsPeriod, newsTemplate, resultDay, sameEvent, searchResults, withoutRepeats } from 'core'

// grokbar c3 R2/R3: "검색 결과 페이지에서 실제 기사 링크를 가져오지 못해서" - the reader kept the first 25 anchors of the page.
// These are real results pages (saved 2026-11-17, scripts, styles and attributes other than href/role removed).
const saved = (name: string, url: string) => plainPage(readFileSync(new URL(`./fixtures/search-results/${name}.html`, import.meta.url), 'utf8'), url)
const NAVER = 'https://search.naver.com/search.naver?query=%EA%B5%AD%EB%82%B4%20AI%20%EC%8A%A4%ED%83%80%ED%8A%B8%EC%97%85%20%ED%88%AC%EC%9E%90'
const NAVER_NEWS = NAVER.replace('?', '?where=news&')
const BING = 'https://www.bing.com/search?q=iPhone+18+price+release+date'
// The pages were saved on this morning; a result's age is read against it.
const SAVED_AT = new Date(2026, 10, 17, 5, 0)
afterEach(() => { vi.useRealTimers() })
const furniture = /^https?:\/\/(search\.naver\.com|ad\.search\.naver\.com|ader\.naver\.com|help\.naver\.com|keep\.naver\.com|www\.naver\.com|(www\.)?bing\.com)\//

it('the old reading of a results page held no article: its first 25 addresses are tabs, filters and ads', () => {
  const first = [...new Set(saved('naver-web', NAVER).links!.filter(link => link.text.length >= 4).map(link => link.url))].slice(0, 25)
  expect(first.filter(url => !furniture.test(url) && !/naver\.com/.test(url))).toEqual([])
})

it('lists the articles of a Naver results page, not the page\'s own tabs and ads', () => {
  const page = saved('naver-web', NAVER)
  const results = searchResults(page.links!, page.text, '국내 AI 스타트업 투자', NAVER, 8, SAVED_AT)
  // c5a r2: one row per site. This page has six sites; its further blog.naver.com posts are not listed.
  expect(results).toHaveLength(6)
  expect(new Set(results.map(one => new URL(one.url).hostname.replace(/^(www|m)\./, ''))).size).toBe(6)
  for (const one of results) expect(one.url).not.toMatch(furniture)
  expect(results.map(one => one.url)).toContain('https://blog.naver.com/paperprogram/224475566836')
  const post = results.find(one => one.url === 'https://blog.naver.com/paperprogram/224475566836')!
  expect(post.title).toMatch(/^\[26년 11월 2주차\]/)
  expect(post.title).not.toContain('새 창 열림')
  // c4 R3: the page says "4일 전"; the result carries the day that was.
  expect(post.date).toBe('11월 13일')
  expect(post.snippet).toContain('엔비디아')
})

it('lists news articles with the outlet\'s own address, what each says and its date', () => {
  const page = saved('naver-news', NAVER_NEWS)
  const results = searchResults(page.links!, page.text, '국내 AI 스타트업 투자', NAVER_NEWS, 8, SAVED_AT)
  expect(results).toHaveLength(8)
  for (const one of results) { expect(one.url).not.toMatch(furniture); expect(one.title.length).toBeGreaterThan(10) }
  // Articles on the outlets' own sites, not Naver's pages about them.
  expect(results.filter(one => !/naver\.com/.test(one.url)).length).toBeGreaterThanOrEqual(6)
  const bloter = results.find(one => one.url === 'https://www.bloter.net/news/articleView.html?idxno=678728')!
  expect(bloter).toMatchObject({ title: expect.stringContaining('최태원 차녀'), date: '11월 16일', snippet: expect.stringContaining('국내 법인') })
  expect(results.filter(one => one.date).length).toBeGreaterThanOrEqual(5)
})

it('lists the sites behind a Bing results page', () => {
  const page = saved('bing', BING)
  const results = searchResults(page.links!, page.text, 'iPhone 18 price release date', BING)
  expect(results.length).toBeGreaterThanOrEqual(5)
  for (const one of results) expect(one.url).not.toMatch(furniture)
  expect(results.map(one => new URL(one.url).hostname)).toEqual(expect.arrayContaining(['www.apple.com', 'en.wikipedia.org']))
  // The title, not the line that shows the address.
  for (const one of results) expect(one.title).not.toMatch(/https?:\/\/|›/)
})

it('search_web hands over results a lookup can answer from, and a news ask is searched in the news tab', async () => {
  vi.useFakeTimers({ now: SAVED_AT, toFake: ['Date'] })
  const asked: string[] = []
  const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage: async (url: string) => { asked.push(url); return { ...saved(url.includes('where=news') ? 'naver-news' : 'naver-web', url), url } } } as never })
    .find(one => one.name === 'search_web')!
  const context = { task: '', steps: [], read: '' } as never
  const news = await tool.run({ query: '국내 AI 스타트업 투자 뉴스' }, context)
  expect(new URL(asked[0]!).searchParams.get('where')).toBe('news')
  expect(news).toMatch(/^results for "국내 AI 스타트업 투자 뉴스" at https:\/\/search\.naver\.com\/\S+ \(DATA/)
  expect(news).toMatch(/- \[단독\]최태원 차녀[^\n]* — https:\/\/www\.bloter\.net\/news\/articleView\.html\?idxno=678728 — [^\n]* — 11월 16일/)
  // c4 R3/H6: no age is left for the model to copy, in the results or in the page's own words.
  expect(news).not.toMatch(/\d+\s*(분|시간|일|주|개월)\s*전/)
  // c5: a news list gets up to 12 rows; a plain search keeps 8. One row per site either way (c5a r2), so the web page's six sites are six rows.
  const newsRows = news.split('\n').filter(line => line.startsWith('- '))
  // c6 R3/H6: 7 of this page's 12 rows are one announcement (엔비디아's investment in four startups); one of them is listed.
  expect(newsRows).toHaveLength(6)
  expect(newsRows.filter(line => line.includes('엔비디아'))).toHaveLength(1)
  expect(new Set(newsRows.map(line => new URL(/ — (https?:\S+)/.exec(line)![1]!).hostname.replace(/^(www|m)\./, ''))).size).toBe(6)
  await tool.run({ query: '국내 AI 스타트업 투자', kind: 'news' }, context)
  expect(new URL(asked[1]!).searchParams.get('where')).toBe('news')
  expect((await tool.run({ query: '국내 AI 스타트업 투자' }, context)).split('\n').filter(line => line.startsWith('- '))).toHaveLength(6)
  expect(new URL(asked[2]!).searchParams.has('where')).toBe(false)
  expect(tool.description).toMatch(/"kind": "news"/)
})

// grokbar c4 R3/H6: the news table's dates read "1주 전 / 1주 전 / 11시간 전". An age is the calendar date it means, from the time of the fetch.
it('turns a result\'s age into the calendar date it means and leaves a written date alone', () => {
  const now = new Date(2026, 10, 17, 9, 30)
  expect(calendarDates('1주 전', now)).toBe('11월 10일')
  expect(calendarDates('11시간 전', now)).toBe('11월 16일')
  expect(calendarDates('3시간 전', now)).toBe('11월 17일')
  expect(calendarDates('40분 전', now)).toBe('11월 17일')
  expect(calendarDates('4일 전', now)).toBe('11월 13일')
  expect(calendarDates('2개월 전', now)).toBe('9월 17일')
  expect(calendarDates('어제', now)).toBe('11월 16일')
  expect(calendarDates('그저께', now)).toBe('11월 15일')
  // Another year is named.
  expect(calendarDates('1년 전', now)).toBe('2025년 11월 17일')
  expect(calendarDates('3주 전', new Date(2027, 0, 5, 9))).toBe('2026년 12월 15일')
  // c4 r3: a month or a year back from a day the earlier month does not have is that month's last day, never a day in the later month.
  expect(calendarDates('1개월 전', new Date(2026, 2, 31, 9))).toBe('2월 28일')
  expect(calendarDates('1달 전', new Date(2026, 4, 31, 9))).toBe('4월 30일')
  expect(calendarDates('3 months ago', new Date(2026, 4, 31, 9))).toBe('Feb 28')
  expect(calendarDates('1년 전', new Date(2028, 1, 29, 9))).toBe('2027년 2월 28일')
  // English ages read as English dates.
  expect(calendarDates('2 days ago', now)).toBe('Nov 15')
  expect(calendarDates('5 hours ago', now)).toBe('Nov 17')
  expect(calendarDates('yesterday', now)).toBe('Nov 16')
  // c4a review r3: under a Korean ask an English age is a Korean date ("Nov 15" reached a Korean thread), in a result's date and in its words.
  expect(calendarDates('2 days ago', now, true, true)).toBe('11월 15일')
  expect(calendarDates('yesterday', now, true, true)).toBe('11월 16일')
  expect(calendarDates('1 year ago', now, true, true)).toBe('2025년 11월 17일')
  const url = 'https://news.example/nvidia-ai-startup'
  const anchors = [{ text: 'Nvidia invests in a Korean AI startup', url }, { text: '2 days ago', url }, { text: 'Nvidia said 5 hours ago that it will invest in a Korean AI startup this year', url }]
  const english = searchResults(anchors, '', '엔비디아 AI 스타트업 투자 nvidia', 'https://www.bing.com/news/search?q=x', 8, now)
  expect(english[0]!.date).toBe('11월 15일')
  expect(english[0]!.snippet).toContain('11월 17일')
  expect(`${english[0]!.snippet} ${english[0]!.date}`).not.toMatch(/Nov \d|ago/)
  // An English ask keeps English dates.
  expect(searchResults(anchors, '', 'nvidia ai startup', 'https://www.bing.com/news/search?q=x', 8, now)[0]!.date).toBe('Nov 15')
  // A written date stays as it is.
  expect(calendarDates('2026.11.10.', now)).toBe('2026.11.10.')
  expect(calendarDates('Nov 3, 2026', now)).toBe('Nov 3, 2026')
  // In running text an age is a date too, but "어제" there is a word, not a date label.
  expect(calendarDates('연합뉴스 1주 전 엔비디아가 투자했다', now, false)).toBe('연합뉴스 11월 10일 엔비디아가 투자했다')
  expect(calendarDates('어제보다 2° 높아요', now, false)).toBe('어제보다 2° 높아요')
})

// grokbar c5 R2: three lookups each cited "네이버 블로그". One row per site first, a maker's or an outlet's page before a blog, café or forum.
it('keeps one row per site, community posts after the others, and still returns a blog when only blogs exist', () => {
  const row = (title: string, url: string) => ({ text: title, url })
  const anchors = [
    row('갤럭시 S27 가격 출시일 총정리 후기 모음', 'https://blog.naver.com/a/1'),
    row('갤럭시 S27 가격 출시일 예상 스펙', 'https://blog.naver.com/b/2'),
    row('갤럭시 S27 가격 출시일 루머 정리', 'https://m.blog.naver.com/c/3'),
    row('갤럭시 S27 가격 출시일 이야기', 'https://phone.tistory.com/9'),
    row('갤럭시 S27 출시일 확정', 'https://news.samsung.com/kr/s27'),
    row('갤럭시 S27 가격 인상 전망', 'https://www.yna.co.kr/view/AKR1'),
    row('갤럭시 S27 가격 또 오른다', 'https://www.yna.co.kr/view/AKR2'),
  ]
  const hosts = (cap: number) => searchResults(anchors, '', '갤럭시 S27 가격 출시일', 'https://search.naver.com/search.naver?query=x', cap).map(one => new URL(one.url).hostname)
  // Outlets and the maker first, one each; then one post per community site; a site's second row is not listed (c5a r2).
  expect(hosts(8).slice(0, 2).sort()).toEqual(['news.samsung.com', 'www.yna.co.kr'])
  expect(hosts(8).slice(2).sort()).toEqual(['blog.naver.com', 'phone.tistory.com'])
  // Only blogs: the best one is still returned, and only one (c5a r2: three blog.naver.com rows came back as three sources).
  const blogs = [1, 2, 3].map(n => row('갤럭시 S27 가격 출시일 예상', `https://blog.naver.com/p${n}/${n}`))
  expect(searchResults(blogs, '', '갤럭시 S27 가격 출시일', 'https://search.naver.com/search.naver?query=x').map(one => one.url)).toEqual(['https://blog.naver.com/p1/1'])
  expect(searchResults(anchors.slice(0, 3), '', '갤럭시 S27 가격 출시일', 'https://search.naver.com/search.naver?query=x')).toHaveLength(1)
  const wiki = [1, 2, 3].map(n => row(`휴가 규정 안내 ${n}판`, `https://wiki.example.com/page/${n}`))
  // c5a r3: a site's own search is no exception.
  expect(searchResults(wiki, '', '휴가 규정', 'https://wiki.example.com/search?q=x').map(one => new URL(one.url).hostname)).toEqual(['wiki.example.com'])
})

// c5a r2: an old article dated "2024년 4월 16일" had no date read, and a row with no date passes the recent-news filter.
it('reads a date written with 년 월 일 or with hyphens, so an old article is out of a recent period', () => {
  const now = new Date(2026, 10, 17), url = 'https://news.example/2024', from = 'https://search.naver.com/search.naver?where=news'
  for (const [written, shown] of [['2024년 4월 16일', '2024년 4월 16일'], ['2024년4월16일', '2024년4월16일'], ['2024-04-16', '2024-04-16'], ['2024.04.16.', '2024.04.16.']] as const) {
    const [old] = searchResults([{ text: '국내 AI 스타트업 투자 유치', url }, { text: written, url }], '', '국내 AI 스타트업 투자 뉴스', from, 12, now)
    expect(old!.date).toBe(shown)
    expect(inPeriod(old!.date, 'month', now)).toBe(false)
    expect(resultDay(old!.date, now)).toEqual(new Date(2024, 3, 16))
  }
  // The date in the line under the title, not only in an anchor of its own.
  const [under] = searchResults([{ text: '국내 AI 스타트업 투자 유치 소식', url }], '국내 AI 스타트업 투자 유치 소식\n한국경제 2024년 4월 16일\n', '국내 AI 스타트업 투자 뉴스', from, 12, now)
  expect(inPeriod(under!.date, 'month', now)).toBe(false)
  // A recent one written the same way stays.
  const [recent] = searchResults([{ text: '국내 AI 스타트업 투자 유치', url }, { text: '2026년 11월 10일', url }], '', '국내 AI 스타트업 투자 뉴스', from, 12, now)
  expect(inPeriod(recent!.date, 'month', now)).toBe(true)
})

// grokbar c5 R3/H6: "요즘 … 투자 뉴스" came back as 2024 rounds. A recent-news ask is searched with a period and filtered by date on the host.
it('reads the period a news ask names and keeps only rows dated inside it', () => {
  const now = new Date(2026, 10, 17, 9, 30)
  expect(newsPeriod('요즘 국내 AI 스타트업 투자 뉴스 3개만')).toBe('month')
  expect(newsPeriod('최근 반도체 뉴스')).toBe('month')
  expect(newsPeriod('이번 달 뉴스')).toBe('month')
  expect(newsPeriod('이번 주 AI 뉴스 5개')).toBe('week')
  expect(newsPeriod('오늘 경제 뉴스')).toBe('day')
  expect(newsPeriod('recent AI startup news')).toBe('month')
  expect(newsPeriod('this week in AI news')).toBe('week')
  expect(newsPeriod("today's headlines")).toBe('day')
  expect(newsPeriod('국내 AI 스타트업 투자 뉴스')).toBeUndefined()
  // Naver's own period buttons: nso=…p:1d / 1w / 1m.
  const template = 'https://search.naver.com/search.naver?query={q}'
  expect(new URL(newsTemplate(template, 'week').replace('{q}', 'x')).searchParams.get('nso')).toBe('so:r,p:1w,a:all')
  expect(new URL(newsTemplate(template, 'month').replace('{q}', 'x')).searchParams.get('nso')).toBe('so:r,p:1m,a:all')
  expect(new URL(newsTemplate(template, 'day').replace('{q}', 'x')).searchParams.get('nso')).toBe('so:r,p:1d,a:all')
  expect(new URL(newsTemplate(template).replace('{q}', 'x')).searchParams.has('nso')).toBe(false)
  expect(newsTemplate('https://www.bing.com/search?q={q}', 'week')).toBe('https://www.bing.com/search?q={q}')
  expect(resultDay('11월 13일', now)).toEqual(new Date(2026, 10, 13))
  expect(resultDay('2024년 4월 16일', now)).toEqual(new Date(2024, 3, 16))
  expect(resultDay('2024.04.16.', now)).toEqual(new Date(2024, 3, 16))
  expect(resultDay('Nov 15', now)).toEqual(new Date(2026, 10, 15))
  expect(resultDay('Apr 16, 2024', now)).toEqual(new Date(2024, 3, 16))
  // Written with no year, a day still ahead is last year's.
  expect(resultDay('12월 20일', now)).toEqual(new Date(2025, 11, 20))
  expect(resultDay('', now)).toBeNull()
  // In and out, by the day.
  expect(inPeriod('11월 10일', 'week', now)).toBe(true)
  expect(inPeriod('11월 9일', 'week', now)).toBe(false)
  expect(inPeriod('11월 9일', 'month', now)).toBe(true)
  expect(inPeriod('10월 10일', 'month', now)).toBe(false)
  expect(inPeriod('11월 16일', 'day', now)).toBe(true)
  expect(inPeriod('11월 15일', 'day', now)).toBe(false)
  expect(inPeriod('2024.04.16.', 'month', now)).toBe(false)
  expect(inPeriod('2024년 11월 16일', 'month', now)).toBe(false)
  expect(inPeriod('', 'week', now)).toBe(true)
  // An older row says its year.
  expect(datedWithYear('9월 3일', now)).toBe('2026년 9월 3일')
  expect(datedWithYear('Sep 3', now)).toBe('Sep 3, 2026')
  expect(datedWithYear('2024.04.16.', now)).toBe('2024.04.16.')
  expect(datedWithYear('2024년 4월 16일', now)).toBe('2024년 4월 16일')
  expect(askedCount('요즘 뉴스 3개만 찾아줘')).toBe(3)
  expect(askedCount('투자 뉴스 다섯 건')).toBe(5)
  expect(askedCount('top 5 AI news')).toBe(5)
  expect(askedCount('three recent articles')).toBe(3)
  expect(askedCount('요즘 뉴스 찾아줘')).toBeUndefined()
})

it('search_web searches recent news with the period, drops rows outside it and fills a short list from older news with the year kept', async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  const article = (title: string, url: string, date: string) => [{ text: title, url }, { text: date, url }]
  const menu = Array.from({ length: 8 }, (_, i) => ({ text: `메뉴 ${i}`, url: `https://search.naver.com/search.naver?where=tab${i}&query=x` }))
  const fresh = [...article('리벨리온 AI 스타트업 투자 유치 620억', 'https://www.yna.co.kr/view/1', '3일 전'), ...article('업스테이지 AI 스타트업 투자 시리즈B', 'https://www.etnews.com/2', '1주 전')]
  const old = [...article('파네시아 AI 스타트업 투자 800억', 'https://www.viva100.com/3', '2024.11.19.'), ...article('뤼튼 AI 스타트업 투자 유치', 'https://www.hankyung.com/4', '2개월 전')]
  const body = (rows: { text: string }[]) => rows.map(row => row.text).join('\n').padEnd(500, ' .')
  const asked: string[] = []
  // The period page did not keep to its period: it lists a 2024 article too.
  const fetchPage = async (url: string) => { asked.push(url); const rows = /p:1m/.test(new URL(url).searchParams.get('nso') ?? '') ? [...fresh, ...old.slice(0, 2)] : [...old, ...fresh]; return { url, text: body(rows), links: [...menu, ...rows] } }
  const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage } as never }).find(one => one.name === 'search_web')!
  const rowsOf = (out: string) => out.split('\n').filter(line => line.startsWith('- '))
  // Three asked, two recent: the older rows after the recent ones. c6: a counted ask loads the wider page (the last year) with the
  // period page, and a row older than a year (the 2024 one) fills nothing.
  const out = await tool.run({ query: 'AI 스타트업 투자 뉴스' }, { task: '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘', steps: [], read: '' } as never)
  // c11b: no search in the event's own words follows (the host judges no headline): the period page, then the year's, and that is all.
  expect(asked.map(url => new URL(url).searchParams.get('nso'))).toEqual(['so:r,p:1m,a:all', 'so:r,p:1y,a:all'])
  expect(out).toContain('They asked for 3')
  expect(rowsOf(out).map(line => line.split(' — ').at(-1))).toEqual(['11월 14일', '11월 10일', '2026년 9월 17일'])
  expect(out).toContain('The first 2 are from the last month')
  expect(out).toContain('the next most recent older ones fill that number, each with its own date and year')
  // The page's own words named the 2024 article: they are left out with its row.
  expect(out.split('\n').filter(line => !line.startsWith('- ')).join('\n')).not.toContain('파네시아')
  // c6: a counted ask always has the older rows behind the recent ones (the rows may be fewer events than they look), never a 2024 one.
  asked.length = 0
  const two = await tool.run({ query: 'AI 스타트업 투자 뉴스' }, { task: '요즘 AI 스타트업 투자 뉴스 2개만', steps: [], read: '' } as never)
  // The same two loads, whatever the rows say.
  expect(asked).toHaveLength(2)
  expect(rowsOf(two).map(line => line.split(' — ').at(-1))).toEqual(['11월 14일', '11월 10일', '2026년 9월 17일'])
  expect(two).not.toContain('2024')
  // No count said and the recent rows are few: the wider page is loaded after the count, as before.
  asked.length = 0
  const some = await tool.run({ query: 'AI 스타트업 투자 뉴스' }, { task: '요즘 AI 스타트업 투자 뉴스 찾아줘', steps: [], read: '' } as never)
  expect(asked.map(url => new URL(url).searchParams.get('nso'))).toEqual(['so:r,p:1m,a:all', 'so:r,p:1y,a:all'])
  expect(rowsOf(some)).toHaveLength(3)
  // No period word: searched as before, nothing dropped.
  asked.length = 0
  const plain = await tool.run({ query: 'AI 스타트업 투자 뉴스' }, { task: 'AI 스타트업 투자 뉴스', steps: [], read: '' } as never)
  expect(new URL(asked[0]!).searchParams.has('nso')).toBe(false)
  expect(rowsOf(plain)).toHaveLength(4)
})

// c6 R3/H6: "엔비디아 … 포인트투테크놀로지 … 투자" came back from 딜라이트닷넷 and 비즈니스포스트 and was listed as items 1 and 2 of 5.
it('c6: a news row that names the same parties as an earlier one is the same event and is dropped; two rounds that share a word are not', () => {
  const row = (title: string, date = '', snippet = '') => ({ title, url: `https://example.com/${encodeURIComponent(title)}`, snippet, date })
  const query = '국내 AI 스타트업 투자 뉴스'
  const first = row('엔비디아, 국내 AI 스타트업 포인트투테크놀로지에 투자 발표…모티프테크놀로지스 등 추가 투자 계획', '11월 10일')
  const second = row('엔비디아, 한국 AI 스타트업 4곳 투자 내역 공개…포인트투테크놀로지·업스테이지 포함', '11월 10일')
  expect(sameEvent(first, second, query)).toBe(true)
  // The second outlet's title names one party only: the other is in the words under it, or the two carry the same date.
  expect(sameEvent(first, row('엔비디아 국내 스타트업 4곳에 투자한다', '11월 12일', '엔비디아가 포인트투테크놀로지 등 국내 AI 스타트업에 투자한다고 밝혔다.'), query)).toBe(true)
  expect(sameEvent(first, row('엔비디아 국내 스타트업 4곳에 투자한다', '11월 10일'), query)).toBe(true)
  // Two different rounds: the words they share are the query's own, a common news word, or "AI" with a query that left it out.
  const a = row('리벨리온, 620억 시리즈C 투자 유치…AI 반도체 양산 속도', '11월 14일'), b = row('업스테이지, 1000억 투자 유치…AI 모델 고도화', '11월 14일')
  expect(sameEvent(a, b, query)).toBe(false)
  expect(sameEvent(a, b, '스타트업 투자 뉴스')).toBe(false)
  // One investor, two rounds on different days, one name shared: two events.
  expect(sameEvent(row('카카오벤처스, 뤼튼에 100억 투자', '11월 3일'), row('카카오벤처스, 업스테이지에 200억 투자', '11월 12일'), query)).toBe(false)
  // c6a r2: the same investor, two rounds on the SAME day: each names a company the other does not, so both are kept.
  const wrtn = row('카카오벤처스 뤼튼에 100억 투자', '11월 17일'), upstage = row('카카오벤처스 업스테이지에 200억 투자', '11월 17일')
  expect(sameEvent(wrtn, upstage, query)).toBe(false)
  expect(withoutRepeats([wrtn, upstage], query)).toEqual([wrtn, upstage])
  // c6a r3: the same pair with a funding word in both ("시드", "후속", a word no list holds): the investor and that word are not two shared parties.
  for (const stage of ['시드', '후속', '프리A', '깜짝']) {
    const one = row(`카카오벤처스 뤼튼에 ${stage} 투자`, '11월 17일'), other = row(`카카오벤처스 업스테이지에 ${stage} 투자`, '11월 17일')
    expect(sameEvent(one, other, query)).toBe(false)
    expect(withoutRepeats([one, other], query)).toEqual([one, other])
  }
  // Without the ending that marks who received it, the funding word is still no party.
  expect(sameEvent(row('카카오벤처스, 뤼튼 시드 투자', '11월 17일'), row('카카오벤처스, 업스테이지 시드 투자', '11월 17일'), query)).toBe(false)
  // One round reported twice stays one row: the second outlet names the same receiver, or mentions it under the title.
  expect(sameEvent(row('카카오벤처스 뤼튼에 시드 투자', '11월 17일'), row('카카오벤처스, 뤼튼에 시드 투자 단행', '11월 17일'), query)).toBe(true)
  expect(sameEvent(first, row('엔비디아, 모티프테크놀로지스에 투자', '11월 10일', '포인트투테크놀로지 등 4곳이 대상이다.'), query)).toBe(true)
  expect(withoutRepeats([first, a, second, b], query)).toEqual([first, a, b])
})

it('c6: a counted news ask loads the period page and then the wider page, never both in the one tab at once, and a repeat of a recent event does not fill the list', async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  const article = (title: string, url: string, date: string) => [{ text: title, url }, { text: date, url }]
  const menu = Array.from({ length: 8 }, (_, i) => ({ text: `메뉴 ${i}`, url: `https://search.naver.com/search.naver?where=tab${i}&query=x` }))
  // The month holds one event, reported by two outlets.
  const fresh = [...article('엔비디아, AI 스타트업 포인트투테크놀로지 투자 발표', 'https://www.delighti.co.kr/1', '1주 전'), ...article('엔비디아 AI 스타트업 투자 내역 공개…포인트투테크놀로지 포함', 'https://www.businesspost.co.kr/2', '1주 전')]
  // The year holds the same event once more, two older rounds and a 2024 article.
  const wide = [...article('엔비디아, 포인트투테크놀로지 AI 스타트업 투자', 'https://www.yna.co.kr/3', '1주 전'), ...article('뤼튼 AI 스타트업 투자 유치 830억', 'https://www.hankyung.com/4', '2026.09.17.'), ...article('리벨리온 AI 스타트업 투자 620억', 'https://www.etnews.com/5', '2026.10.20.'), ...article('파네시아 AI 스타트업 투자 800억', 'https://www.viva100.com/6', '2024.11.19.')]
  const body = (rows: { text: string }[]) => rows.map(row => row.text).join('\n').padEnd(500, ' .')
  const open: string[] = []
  let together = 0
  const fetchPage = async (url: string) => { open.push(url); together = Math.max(together, open.length); await new Promise(resolve => setTimeout(resolve, 5)); open.splice(open.indexOf(url), 1); const rows = /p:1m/.test(new URL(url).searchParams.get('nso') ?? '') ? fresh : wide; return { url, text: body(rows), links: [...menu, ...rows] } }
  const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage } as never }).find(one => one.name === 'search_web')!
  const out = await tool.run({ query: 'AI 스타트업 투자 뉴스' }, { task: '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘', steps: [], read: '' } as never)
  // stack-6 (c6a run, R3/H6): the two loads share one tab; opened together the second cut the first off and the search "did not run".
  expect(together).toBe(1)
  const rows = out.split('\n').filter(line => line.startsWith('- '))
  // One row for the event of the month, then the older rounds, most recent first, each with its year; nothing from 2024.
  // c11b: the month's event comes first like any row of the period: no headline sends it behind the rounds as background.
  expect(rows.map(line => [/ — (https?:\S+)/.exec(line)![1], line.split(' — ').at(-1)])).toEqual([['https://www.businesspost.co.kr/2', '11월 10일'], ['https://www.etnews.com/5', '2026.10.20.'], ['https://www.hankyung.com/4', '2026.09.17.']])
  expect(out).toContain('The first 1 are from the last month')
  expect(out).toContain('They asked for 5')
  expect(out).not.toMatch(/Background only|The rows that are the event asked for/)
})

// ---- cycle 7 (c7a) ----
// c6a review r3 #1: one investor, two rounds, no 에 ending and a shared descriptive word.
it('c7: two rows are one event only when the funded company matches, not when only the investor does', () => {
  const row = (title: string, date = '11월 17일', snippet = '') => ({ title, url: `https://example.com/${encodeURIComponent(title)}`, snippet, date })
  const query = '국내 AI 스타트업 투자 유치'
  const wrtn = row('카카오벤처스 뤼튼 깜짝 투자'), upstage = row('카카오벤처스 업스테이지 깜짝 투자')
  expect(sameEvent(wrtn, upstage, query)).toBe(false)
  expect(withoutRepeats([wrtn, upstage], query)).toEqual([wrtn, upstage])
  for (const word of ['전격', '단독 후속', '대규모']) expect(sameEvent(row(`카카오벤처스, 뤼튼 ${word} 투자`), row(`카카오벤처스, 업스테이지 ${word} 투자`), query), word).toBe(false)
  // The same round from two outlets is still one row: the company after the investor is the same, or the other row mentions it.
  expect(sameEvent(wrtn, row('카카오벤처스 뤼튼 전격 투자'), query)).toBe(true)
  expect(sameEvent(wrtn, row('카카오벤처스, 생성형 AI 깜짝 투자', '11월 17일', '카카오벤처스가 뤼튼에 투자했다.'), query)).toBe(true)
  // The R3 repeat of cycle 6 is still one event: both titles name the same company after the investor.
  const first = row('엔비디아, 국내 AI 스타트업 포인트투테크놀로지에 투자 발표…모티프테크놀로지스 등 추가 투자 계획', '11월 10일')
  expect(sameEvent(first, row('엔비디아, 한국 AI 스타트업 4곳 투자 내역 공개…포인트투테크놀로지·업스테이지 포함', '11월 10일'), query)).toBe(true)
  expect(sameEvent(first, row('엔비디아, 모티프테크놀로지스에 투자', '11월 10일', '포인트투테크놀로지 등 4곳이 대상이다.'), query)).toBe(true)
})

// R3 of the run: item 3 "…대학기술지주 투자 포트폴리오 내 인수 사례로 언급", item 5 "…(구체 금액·기업명 미확인)". c11b: which rows are the
// event is the model's call (the search asks it to leave out what only touches the topic); the host ranks no headline, every row in the
// period reaches the model, dated ones first, and nothing dated over twelve months back.
it('c7 R3 (c11b): a counted news ask hands over every row of the year, a forum or a portfolio mention included, unranked; nothing dated over twelve months back', async () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘'
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  const article = (title: string, url: string, date: string) => [{ text: title, url }, { text: date, url }]
  const menu = Array.from({ length: 8 }, (_, i) => ({ text: `메뉴 ${i}`, url: `https://search.naver.com/search.naver?where=tab${i}&query=x` }))
  const fresh = [...article('AI 스타트업 투자 유치 포럼 내달 개최', 'https://www.forum.example/1', '3일 전'), ...article('업스테이지, LS그룹서 1500억 투자 유치', 'https://www.globalnews.example/2', '1일 전')]
  const wide = [...article('대학기술지주 AI 스타트업 투자 포트폴리오 성과…리벨리온 인수 사례 언급', 'https://www.economist.example/3', '2026.10.12.'), ...article('아크 AI 스타트업 시리즈A 200억 투자 유치', 'https://www.viva.example/4', '2026.10.14.'), ...article('홀리데이로보틱스 AI 스타트업 투자 유치 1550억', 'https://www.smart.example/5', '2026.07.13.'), ...article('서벌 AI 스타트업 투자 유치 120억', 'https://www.token.example/6', '2025.11.01.')]
  const body = (rows: { text: string }[]) => rows.map(row => row.text).join('\n').padEnd(500, ' .')
  const fetchPage = async (url: string) => { const rows = /p:1m/.test(new URL(url).searchParams.get('nso') ?? '') ? fresh : /p:1y/.test(new URL(url).searchParams.get('nso') ?? '') ? wide : [...fresh, ...wide]; return { url, text: body(rows), links: [...menu, ...rows] } }
  const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage } as never }).find(one => one.name === 'search_web')!
  // The host's words for this ask (fast-lane laneQuery), as a news search.
  const out = await tool.run({ query: '국내 AI 스타트업 투자 유치', kind: 'news' }, { task: ask, steps: [], read: '' } as never)
  const urls = out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1])
  // The month's rows in the page's order (the forum too), then the year's most recent first; the one from over a year back is gone.
  expect(urls).toEqual(['https://www.forum.example/1', 'https://www.globalnews.example/2', 'https://www.viva.example/4', 'https://www.economist.example/3', 'https://www.smart.example/5'])
  expect(out).toContain('They asked for 5')
  expect(out).toContain('a row that only touches the topic (a statistic, a plan, an opinion piece) is not one')
  expect(out).not.toMatch(/Background only|The rows that are the event asked for/)
  expect(out).not.toContain('token.example')
  // With no period said, a counted news list still takes nothing dated over twelve months back; a list that was not counted is left as it was.
  const counted = await tool.run({ query: 'AI 스타트업 투자 유치', kind: 'news' }, { task: 'AI 스타트업 투자 뉴스 5개 찾아줘', steps: [], read: '' } as never)
  expect(counted).not.toContain('token.example')
  expect(counted).toContain('economist.example')
  expect(await tool.run({ query: 'AI 스타트업 투자 유치', kind: 'news' }, { task: 'AI 스타트업 투자 뉴스 찾아줘', steps: [], read: '' } as never)).toContain('token.example')
  vi.useRealTimers()
})

// c7 R2: every row of a product comparison was cited to a blog post or a video.
it('c7 R2: in one result list a publication or an official site comes before a blog, café or video post; nothing is dropped', () => {
  const links = [{ text: '갤럭시 S27 가격 출시일 총정리 영상', url: 'https://www.youtube.com/watch?v=abc' }, { text: '갤럭시 S27 가격 출시일 루머 정리', url: 'https://blog.naver.com/a/1' }, { text: '갤럭시 S27 출시일 가격 전망', url: 'https://www.etnews.com/s27' }, { text: '갤럭시 S27 가격 출시일 카페 글', url: 'https://cafe.naver.com/b/2' }, { text: '갤럭시 S27 가격 공개', url: 'https://news.samsung.com/kr/s27' }]
  const urls = searchResults(links, links.map(link => link.text).join('\n'), '갤럭시 S27 가격 출시일', 'https://search.naver.com/search.naver?query=x').map(one => new URL(one.url).hostname)
  expect(urls).toHaveLength(5)
  expect(urls.slice(0, 2).sort()).toEqual(['news.samsung.com', 'www.etnews.com'])
  expect(urls.slice(2).sort()).toEqual(['blog.naver.com', 'cafe.naver.com', 'www.youtube.com'])
})
