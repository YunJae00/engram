import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { citeMembers, figurePages, isSearchPage, pointQueries, sourceName, type TeamMember } from '../src/index.js'

const r2 = JSON.parse(readFileSync(new URL('./fixtures/c9a-r2-helpers.json', import.meta.url), 'utf8')) as { members: TeamMember[] }
const links = (text: string): string[] => [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map(found => found[1]!)
const host = (url: string): string => new URL(url).hostname
const search = (words: string): string => `https://search.naver.com/search.naver?query=${encodeURIComponent(words)}`

test('c9a R2: the stored three helpers through the merge give three rows on three hosts, platform names, a figure in every price cell', () => {
  // The lead's table as the live run wrote it: two café links and the 픽셀 helper's search page, all named 출처.
  const table = ['셋이 하나씩 맡아서 알아봤어요.', '', '| 모델 | 가격 | 출시일 | 출처 |', '|---|---|---|---|',
    '| 아이폰 18 | 일반형은 미발표 (프로 기준 199만 원부터) | 일반형은 내년 봄 예상 (프로·듀오는 10월 23일 이미 출시) | [출처](https://cafe.naver.com/appletouch/2303631) |',
    '| 갤럭시 S27 | 미발표, 전작 S26 140만 3,600원 | 미발표, 2027년 1~2월 공개설 | [출처](https://cafe.naver.com/sm2022sf/1328949) |',
    `| 픽셀 11 | 899달러부터 (기본형, 미국 기준) | 2026년 8월 12일 공개, 8월 20일 판매 시작 | [출처](${search('구글 픽셀 11 가격 출시일')}) |`].join('\n')
  const out = citeMembers(table, r2.members, true)
  const shown = links(out)
  expect(shown).toHaveLength(3)
  expect(new Set(shown.map(host)).size).toBe(3)
  // A real page wherever its helper cited one; 픽셀 cited none, so its search page stays, named as what it is.
  expect(shown.slice(0, 2).some(isSearchPage)).toBe(false)
  expect(out).toContain('[스마트스토어](https://smartstore.naver.com/main/products/12990053235)')
  expect(out).toContain('[네이버 카페](https://cafe.naver.com/appletouch/2303631)')
  expect(out).not.toMatch(/\[출처\]/)
  for (const row of out.split('\n').filter(line => /^\| (아이폰|갤럭시|픽셀)/.test(line))) expect(row.split('|')[2], row).toMatch(/\d.*(원|달러)|미발표/)
})

test('c9a R2: a search page never stands for a row whose helper cited a real page', () => {
  const head = '| 모델 | 가격 | 출시일 | 출처 |\n|---|---|---|---|\n'
  const tesla: TeamMember = { id: 'm1', parentId: null, depth: 1, role: 'tesla', brief: '테슬라 모델 2의 가격과 출시일 조사', lookup: true, state: 'done', sessionKey: 's1', hiredAt: '', sources: [search('테슬라 모델 2 가격 출시일')], result: '가격: 예상 2만 5천 달러 — https://www.hankyung.com/article/2026111700001\n출시일: 2027년 상반기 예상 — https://blog.naver.com/ev/1' }
  const byd: TeamMember = { id: 'm2', parentId: null, depth: 1, role: 'byd', brief: 'BYD 돌핀의 가격과 출시일 조사', lookup: true, state: 'done', sessionKey: 's2', hiredAt: '', sources: [search('BYD 돌핀 가격 출시일'), 'https://www.hankyung.com/article/2026111700009'], result: '가격: 2,450만 원부터 — https://blog.naver.com/ev/2\n출시일: 2025년 4월 15일 국내 출시 — https://www.hankyung.com/article/2026111700009' }
  const out = citeMembers(`${head}| 테슬라 모델 2 | 예상 2만 5천 달러 | 2027년 상반기 예상 | [출처](${search('테슬라 모델 2 가격 출시일')}) |\n| BYD 돌핀 | 2,450만 원부터 | 2025년 4월 15일 | [출처](https://blog.naver.com/ev/2) |`, [tesla, byd], true)
  const shown = links(out)
  expect(shown.some(isSearchPage)).toBe(false)
  // A publication comes before a blog post, even on a host an earlier row uses (테슬라: no figure on either page).
  // c9a r2 (Codex r1): BYD's price 2,450만 원 is only on the blog post, its date only in the paper: the row links both, so the price keeps its source.
  expect(shown).toEqual(['https://www.hankyung.com/article/2026111700001', 'https://www.hankyung.com/article/2026111700009', 'https://blog.naver.com/ev/2'])
  expect(out.split('\n').at(-1)).toMatch(/\]\(https:\/\/www\.hankyung\.com\/article\/2026111700009\) · \[[^\]]+\]\(https:\/\/blog\.naver\.com\/ev\/2\) \|$/)
  // One page holding every figure is the row's one source, before a publication that holds none.
  const one: TeamMember = { ...byd, result: '가격: 2,450만 원부터, 2025년 4월 15일 출시 — https://blog.naver.com/ev/2\n소식 — https://www.hankyung.com/article/2026111700009' }
  expect(links(citeMembers(`${head}| BYD 돌핀 | 2,450만 원부터 | 2025년 4월 15일 | [출처](https://www.hankyung.com/article/2026111700009) |`, [one], true))).toEqual(['https://blog.naver.com/ev/2'])
  // Between equals, a host no earlier row uses: two posts, one on the earlier row's host.
  const a: TeamMember = { ...tesla, sources: [], result: '가격: 2만 5천 달러 — https://cafe.naver.com/ev/1' }
  const b: TeamMember = { ...byd, sources: [], result: '가격: 2,450만 원부터 — https://cafe.naver.com/ev/2\n출시일: 2025년 4월 15일 — https://www.youtube.com/watch?v=x1' }
  const spread = citeMembers(`${head}| 테슬라 모델 2 | 2만 5천 달러 | 미정 | [출처](https://cafe.naver.com/ev/1) |\n| BYD 돌핀 | 2,450만 원부터 | 2025년 4월 15일 | [출처](https://cafe.naver.com/ev/2) |`, [a, b], true)
  // c9a r2: the price is only on the cafe post, the date only in the video: the row links both.
  expect(links(spread)).toEqual(['https://cafe.naver.com/ev/1', 'https://www.youtube.com/watch?v=x1', 'https://cafe.naver.com/ev/2'])
  const c: TeamMember = { ...byd, sources: [], result: '소식 — https://cafe.naver.com/ev/2\n소식 — https://www.youtube.com/watch?v=x1' }
  const apart = citeMembers(`${head}| 테슬라 모델 2 | 2만 5천 달러 | 미정 | [출처](https://cafe.naver.com/ev/1) |\n| BYD 돌핀 | 미정 | 미정 | [출처](https://cafe.naver.com/ev/2) |`, [a, c], true)
  expect(links(apart)).toEqual(['https://cafe.naver.com/ev/1', 'https://www.youtube.com/watch?v=x1'])
  expect(apart).toContain('[유튜브](https://www.youtube.com/watch?v=x1)')
})

test('c9a r3 (Codex r2): a source cell with a search page beside an article keeps the article only', () => {
  const head = '| 모델 | 가격 | 출처 |\n|---|---|---|\n'
  const m: TeamMember = { id: 'm1', parentId: null, depth: 1, role: 'tesla', brief: '테슬라 모델 2 가격', lookup: true, state: 'done', sessionKey: 's1', hiredAt: '', sources: [search('테슬라 모델 2 가격')], result: '가격: 2만 5천 달러 — https://www.hankyung.com/article/2026111700001' }
  const out = citeMembers(`${head}| 테슬라 모델 2 | 2만 5천 달러 | [네이버 검색](${search('테슬라 모델 2 가격')}) · [한국경제](https://www.hankyung.com/article/2026111700001) |`, [m], true)
  expect(links(out)).toEqual(['https://www.hankyung.com/article/2026111700001'])
  // Two search pages only: the teammate's real page takes their place.
  const two = citeMembers(`${head}| 테슬라 모델 2 | 2만 5천 달러 | [네이버 검색](${search('테슬라 모델 2 가격')}) · [네이버 검색](${search('모델 2')}) |`, [m], true)
  expect(links(two)).toEqual(['https://www.hankyung.com/article/2026111700001'])
})

test('c9a R2: platforms are named by the platform; a search page and an unknown site keep their names', () => {
  expect(sourceName('https://cafe.naver.com/appletouch/2303631', true)).toBe('네이버 카페')
  expect(sourceName('https://m.blog.naver.com/a/1', true)).toBe('네이버 블로그')
  expect(sourceName('https://www.youtube.com/watch?v=s3wLAIMQpPs', true)).toBe('유튜브')
  expect(sourceName('https://smartstore.naver.com/main/products/1', true)).toBe('스마트스토어')
  expect(sourceName('https://someone.tistory.com/12', true)).toBe('티스토리')
  expect(sourceName('https://brunch.co.kr/@a/3', true)).toBe('브런치')
  expect(sourceName(search('아이폰 18 가격'), true)).toBe('네이버 검색')
  expect(sourceName('https://phones.example/x', true)).toBe('출처')
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
  // Never drops a number the helper gave.
  expect(figurePages(answer, read)).toContain('899달러부터')
})
