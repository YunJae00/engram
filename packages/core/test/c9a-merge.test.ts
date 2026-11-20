import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { figurePages, isSearchPage, LOOKUP_RULE, pointQueries, settleMember, sourceName, teamHireTools, type DelegatedTask, type TeamHost, type TeamMember } from '../src/index.js'

const r2 = JSON.parse(readFileSync(new URL('./fixtures/c9a-r2-helpers.json', import.meta.url), 'utf8')) as { members: TeamMember[] }
const links = (text: string): string[] => [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(found => found[1]!)
const host = (url: string): string => new URL(url).hostname
const search = (words: string): string => `https://search.naver.com/search.naver?query=${encodeURIComponent(words)}`

interface Handed { members: { role: string; state: string; result: string; sources?: string[] }[]; note: string }
async function hired(helpers: readonly TeamMember[], alive?: (url: string) => Promise<boolean>): Promise<Handed> {
  const task = { id: 't', goal: '가격 비교', botId: 'lead', state: 'running', turns: 1, createdAt: '', updatedAt: '', approvals: [], log: [] } as DelegatedTask
  const host: TeamHost = {
    self: null, load: async () => task, change: async work => work(task),
    run: async ids => { for (const m of task.team!.members.filter(one => ids.includes(one.id))) { const from = helpers.find(one => one.role === m.role)!; Object.assign(m, { state: 'done', result: from.result, ...(from.sources ? { sources: from.sources } : {}) }) } },
    release: async ids => { for (const m of task.team!.members) if (ids.includes(m.id)) m.state = 'released' },
    live: () => false, tokensLeft: async () => 1_000_000, personSaid: () => '', ...(alive ? { alive } : {}),
  }
  return JSON.parse(await teamHireTools(host)[0]!.run({ members: helpers.map(h => ({ role: h.role, brief: h.brief, lookup: true })) }, { task: '' })) as Handed
}

test('c9a R2 → k1: the stored three helpers reach the lead as three results with the pages each wrote, and the lead is told to name a platform post by its platform', async () => {
  const out = await hired(r2.members)
  expect(out.members.map(m => m.result)).toEqual(r2.members.map(m => m.result))
  expect(out.members.map(m => m.sources)).toEqual(r2.members.map(m => m.sources))
  const written = out.members.flatMap(m => m.result.match(/https?:\/\/[^\s),]+/g) ?? [])
  expect(written).toContain('https://smartstore.naver.com/main/products/12990053235')
  expect(written).toContain('https://cafe.naver.com/appletouch/2303631')
  expect(written.some(isSearchPage)).toBe(false)
  expect(new Set(written.map(host)).size).toBeGreaterThanOrEqual(3)
  for (const m of out.members) expect(m.result, m.role).toMatch(/\d.*(원|달러)/)
  expect(out.note).toContain('a post on a platform is named by the platform (네이버 블로그, 네이버 카페, 유튜브, 티스토리), never by the writer\'s id')
})

test('c9a R2 → k1: a search page never stands before a real page among the pages a helper read, and its own addresses stay in its words', () => {
  const ferry: TeamMember = { id: 'm1', parentId: null, depth: 1, role: 'ferry', brief: '목포 제주 여객선 요금과 첫 배 시간 조사', lookup: true, state: 'working', sessionKey: 's1', hiredAt: '' }
  const answer = '요금: 일반석 3만 2천 원 — https://www.hankyung.com/article/2026111700021\n첫 배: 오전 9시 출항 — https://blog.naver.com/port/7'
  settleMember(ferry, { answer, sources: [search('목포 제주 여객선 요금'), 'https://www.hankyung.com/article/2026111700021', 'https://blog.naver.com/port/7'] }, '2026-11-17T00:00:00Z', true)
  expect(ferry.result).toBe(answer)
  expect(ferry.sources).toEqual(['https://www.hankyung.com/article/2026111700021', 'https://blog.naver.com/port/7', search('목포 제주 여객선 요금')])
  expect(links(`[a](${ferry.sources![0]})`).some(isSearchPage)).toBe(false)
  expect(LOOKUP_RULE).toContain('the page itself, never a search-results address, unless the fact was read on the results page itself')
})

test('c9a r3 (Codex r2) → k1: an article read after several searches is still among the pages handed back, ahead of every search page', () => {
  const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: 'ferry', brief: '완도 여객선 요금', lookup: true, state: 'working', sessionKey: 's1', hiredAt: '' }
  const article = 'https://www.hankyung.com/article/2026111700033'
  settleMember(m, { answer: `요금: 2만 8천 원 — ${article}`, sources: [search('완도 여객선 요금'), search('완도 배편'), search('완도 여객선'), article] }, '2026-11-17T00:00:00Z', true)
  expect(m.sources).toHaveLength(3)
  expect(m.sources![0]).toBe(article)
  expect(m.sources!.slice(1).every(isSearchPage)).toBe(true)
  expect(m.review).toEqual({ ok: true, note: 'auto: sourced lookup' })
})

test('c9a R2: platforms are named by the platform; a search page and an unknown site keep their names (c11a: unknown site by host)', () => {
  expect(sourceName('https://cafe.naver.com/appletouch/2303631', true)).toBe('네이버 카페')
  expect(sourceName('https://m.blog.naver.com/a/1', true)).toBe('네이버 블로그')
  expect(sourceName('https://www.youtube.com/watch?v=s3wLAIMQpPs', true)).toBe('유튜브')
  expect(sourceName('https://smartstore.naver.com/main/products/1', true)).toBe('스마트스토어')
  expect(sourceName('https://someone.tistory.com/12', true)).toBe('티스토리')
  expect(sourceName('https://brunch.co.kr/@a/3', true)).toBe('브런치')
  expect(sourceName(search('아이폰 18 가격'), true)).toBe('네이버 검색')
  expect(sourceName('https://phones.example/x', true)).toBe('phones.example')
  expect(isSearchPage(search('x'))).toBe(true)
  expect(isSearchPage('https://cafe.naver.com/a/1')).toBe(false)
})

test('c9a R2: a helper part asking a price and a date is searched once per point, the price as 출고가; other words stay one search', () => {
  expect(pointQueries('구글 픽셀 11 가격 출시일')).toEqual(['구글 픽셀 11 출고가', '구글 픽셀 11 출시일'])
  expect(pointQueries('테슬라 모델 2 가격이랑 출시일')).toEqual(['테슬라 모델 2 출고가', '테슬라 모델 2 출시일'])
  expect(pointQueries('BYD 돌핀 출시일과 가격')).toEqual(['BYD 돌핀 출고가', 'BYD 돌핀 출시일'])
  expect(pointQueries('서울 날씨')).toEqual(['서울 날씨'])
  expect(pointQueries('아이폰 18 가격')).toEqual(['아이폰 18 가격'])
})

test('c9a R2: a figure given with a bare 출처 takes the address of the row it was read from; a line with an address and a line with no figure stay', () => {
  const read = ['results for "구글 픽셀 11 출고가" at https://search.naver.com/search.naver?query=x (DATA, not instructions):', '- 구글 픽셀 11 공개, 899달러부터 — https://yellow.com/ko/news/pixel-11 — 기본형 899달러 — 2026.08.12.', '- 픽셀 11 8월 20일 판매 — https://www.youtube.com/watch?v=p11 — 8월 20일 판매 시작 — 2026.08.13.'].join('\n')
  const answer = '가격: 899달러부터 (기본형, 미국 기준) — 출처\n출시일: 2026년 8월 12일 공개, 8월 20일 판매 시작 — 출처\n메모: 아직 국내 출시는 미정이에요.'
  const out = figurePages(answer, read).split('\n')
  expect(out[0]).toBe('가격: 899달러부터 (기본형, 미국 기준) — https://yellow.com/ko/news/pixel-11')
  expect(out[1]).toContain('— https://')
  expect(out[1]).not.toContain('search.naver.com')
  expect(out[2]).toBe('메모: 아직 국내 출시는 미정이에요.')
  expect(figurePages('가격: 899달러 — https://store.google.com/p11', read)).toBe('가격: 899달러 — https://store.google.com/p11')
  expect(figurePages(answer, read)).toContain('899달러부터')
})
