import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { plainPage } from '../src/main/plain-page.js'
import { calendarDates, cometTools, searchResults } from 'core'

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
  expect(results).toHaveLength(8)
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
  expect(news.split('\n').filter(line => line.startsWith('- '))).toHaveLength(8)
  await tool.run({ query: '국내 AI 스타트업 투자', kind: 'news' }, context)
  expect(new URL(asked[1]!).searchParams.get('where')).toBe('news')
  await tool.run({ query: '국내 AI 스타트업 투자' }, context)
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
  // A written date stays as it is.
  expect(calendarDates('2026.11.10.', now)).toBe('2026.11.10.')
  expect(calendarDates('Nov 3, 2026', now)).toBe('Nov 3, 2026')
  // In running text an age is a date too, but "어제" there is a word, not a date label.
  expect(calendarDates('연합뉴스 1주 전 엔비디아가 투자했다', now, false)).toBe('연합뉴스 11월 10일 엔비디아가 투자했다')
  expect(calendarDates('어제보다 2° 높아요', now, false)).toBe('어제보다 2° 높아요')
})
