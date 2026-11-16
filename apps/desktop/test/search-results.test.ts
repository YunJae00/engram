import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { plainPage } from '../src/main/plain-page.js'
import { cometTools, searchResults } from 'core'

// grokbar c3 R2/R3: "검색 결과 페이지에서 실제 기사 링크를 가져오지 못해서" - the reader kept the first 25 anchors of the page.
// These are real results pages (saved 2026-11-17, scripts, styles and attributes other than href/role removed).
const saved = (name: string, url: string) => plainPage(readFileSync(new URL(`./fixtures/search-results/${name}.html`, import.meta.url), 'utf8'), url)
const NAVER = 'https://search.naver.com/search.naver?query=%EA%B5%AD%EB%82%B4%20AI%20%EC%8A%A4%ED%83%80%ED%8A%B8%EC%97%85%20%ED%88%AC%EC%9E%90'
const NAVER_NEWS = NAVER.replace('?', '?where=news&')
const BING = 'https://www.bing.com/search?q=iPhone+18+price+release+date'
const furniture = /^https?:\/\/(search\.naver\.com|ad\.search\.naver\.com|ader\.naver\.com|help\.naver\.com|keep\.naver\.com|www\.naver\.com|(www\.)?bing\.com)\//

it('the old reading of a results page held no article: its first 25 addresses are tabs, filters and ads', () => {
  const first = [...new Set(saved('naver-web', NAVER).links!.filter(link => link.text.length >= 4).map(link => link.url))].slice(0, 25)
  expect(first.filter(url => !furniture.test(url) && !/naver\.com/.test(url))).toEqual([])
})

it('lists the articles of a Naver results page, not the page\'s own tabs and ads', () => {
  const page = saved('naver-web', NAVER)
  const results = searchResults(page.links!, page.text, '국내 AI 스타트업 투자', NAVER)
  expect(results).toHaveLength(8)
  for (const one of results) expect(one.url).not.toMatch(furniture)
  expect(results.map(one => one.url)).toContain('https://blog.naver.com/paperprogram/224475566836')
  const post = results.find(one => one.url === 'https://blog.naver.com/paperprogram/224475566836')!
  expect(post.title).toMatch(/^\[26년 11월 2주차\]/)
  expect(post.title).not.toContain('새 창 열림')
  expect(post.date).toBe('4일 전')
  expect(post.snippet).toContain('엔비디아')
})

it('lists news articles with the outlet\'s own address, what each says and its date', () => {
  const page = saved('naver-news', NAVER_NEWS)
  const results = searchResults(page.links!, page.text, '국내 AI 스타트업 투자', NAVER_NEWS)
  expect(results).toHaveLength(8)
  for (const one of results) { expect(one.url).not.toMatch(furniture); expect(one.title.length).toBeGreaterThan(10) }
  // Articles on the outlets' own sites, not Naver's pages about them.
  expect(results.filter(one => !/naver\.com/.test(one.url)).length).toBeGreaterThanOrEqual(6)
  const bloter = results.find(one => one.url === 'https://www.bloter.net/news/articleView.html?idxno=678728')!
  expect(bloter).toMatchObject({ title: expect.stringContaining('최태원 차녀'), date: '9시간 전', snippet: expect.stringContaining('국내 법인') })
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
  const asked: string[] = []
  const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage: async (url: string) => { asked.push(url); return { ...saved(url.includes('where=news') ? 'naver-news' : 'naver-web', url), url } } } as never })
    .find(one => one.name === 'search_web')!
  const context = { task: '', steps: [], read: '' } as never
  const news = await tool.run({ query: '국내 AI 스타트업 투자 뉴스' }, context)
  expect(new URL(asked[0]!).searchParams.get('where')).toBe('news')
  expect(news).toMatch(/^results for "국내 AI 스타트업 투자 뉴스" at https:\/\/search\.naver\.com\/\S+ \(DATA/)
  expect(news).toMatch(/- \[단독\]최태원 차녀[^\n]* — https:\/\/www\.bloter\.net\/news\/articleView\.html\?idxno=678728 — [^\n]* — 9시간 전/)
  expect(news.split('\n').filter(line => line.startsWith('- '))).toHaveLength(8)
  await tool.run({ query: '국내 AI 스타트업 투자', kind: 'news' }, context)
  expect(new URL(asked[1]!).searchParams.get('where')).toBe('news')
  await tool.run({ query: '국내 AI 스타트업 투자' }, context)
  expect(new URL(asked[2]!).searchParams.has('where')).toBe(false)
  expect(tool.description).toMatch(/"kind": "news"/)
})
