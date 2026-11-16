import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { plainPage } from '../src/main/plain-page.js'
import { askedCount, calendarDates, cometTools, datedWithYear, inPeriod, newsPeriod, newsTemplate, resultDay, searchResults } from 'core'

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
  expect(newsRows).toHaveLength(12)
  expect(new Set(newsRows.map(line => new URL(/ — (https?:\S+)/.exec(line)![1]!).hostname.replace(/^(www|m)\./, ''))).size).toBe(12)
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
  const fetchPage = async (url: string) => { asked.push(url); const rows = new URL(url).searchParams.get('nso') ? [...fresh, ...old.slice(0, 2)] : [...old, ...fresh]; return { url, text: body(rows), links: [...menu, ...rows] } }
  const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage } as never }).find(one => one.name === 'search_web')!
  const rowsOf = (out: string) => out.split('\n').filter(line => line.startsWith('- '))
  // Three asked, two recent: one more fetch with no period, the older rows after the recent ones.
  const out = await tool.run({ query: 'AI 스타트업 투자 뉴스' }, { task: '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘', steps: [], read: '' } as never)
  expect(asked.map(url => new URL(url).searchParams.get('nso'))).toEqual(['so:r,p:1m,a:all', null])
  expect(rowsOf(out).map(line => line.split(' — ').at(-1))).toEqual(['11월 14일', '11월 10일', '2024.11.19.', '2026년 9월 17일'])
  expect(out).toContain('The first 2 are from the last month')
  // The page's own words named the 2024 article: they are left out with its row.
  expect(out.split('\n').filter(line => !line.startsWith('- ')).join('\n')).not.toContain('파네시아')
  // Enough recent rows: one fetch, and nothing older is shown.
  asked.length = 0
  const two = await tool.run({ query: 'AI 스타트업 투자 뉴스' }, { task: '요즘 AI 스타트업 투자 뉴스 2개만', steps: [], read: '' } as never)
  expect(asked).toHaveLength(1)
  expect(rowsOf(two).map(line => line.split(' — ').at(-1))).toEqual(['11월 14일', '11월 10일'])
  expect(two).not.toContain('2024')
  // No period word: searched as before, nothing dropped.
  asked.length = 0
  const plain = await tool.run({ query: 'AI 스타트업 투자 뉴스' }, { task: 'AI 스타트업 투자 뉴스', steps: [], read: '' } as never)
  expect(new URL(asked[0]!).searchParams.has('nso')).toBe(false)
  expect(rowsOf(plain)).toHaveLength(4)
})
