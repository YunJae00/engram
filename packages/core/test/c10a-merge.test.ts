import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { citeMembers, keepDeclaredName, liveLinks, oneTier, pageHead, sourceName, type TeamMember } from '../src/index.js'

// The stack-9 run's R2 helpers (runs/stack9-b685945e tasks.json, t-mwkfyhd4-586409) and the table the lead wrote from them.
const r2 = JSON.parse(readFileSync(new URL('./fixtures/c10a-r2-helpers.json', import.meta.url), 'utf8')) as { members: TeamMember[] }
const table = ['셋이 하나씩 맡아서 알아봤어요.', '', '| 제품 | 가격 | 출시일 | 출처 |', '|---|---|---|---|',
  '| 아이폰 18 | 미발표, 프로 기준 199만 원부터(256GB) | 일반형은 2027년 봄 예상 (프로는 이미 출시) | [네이버 블로그](https://blog.naver.com/automobile1004/224479601593) |',
  '| 갤럭시 S27 | 미발표, 예상 기본형 999달러(약 134만 원)부터, 울트라 약 187만 원부터 | 미발표, 2027년 1~2월 언팩 예상 | [출처](https://www.mt.co.kr/tech/2026/10/20/2026101915464770051) |',
  '| 픽셀 11 | 999유로부터(기본 모델) | 2026년 8월 12일 | [위키백과](https://ko.wikipedia.org/wiki/%ED%94%BD%EC%85%80_11_%ED%94%84%EB%A1%9C) |'].join('\n')
const rows = (text: string): string[][] => text.split('\n').filter(line => /^\| (아이폰|갤럭시|픽셀)/.test(line)).map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))

test('c10a R2: the stored helpers through the merge give one tier per row and no link named 출처 on a known host', () => {
  const out = citeMembers(table, r2.members, true), [iphone, galaxy, pixel] = rows(out)
  for (const row of [iphone!, galaxy!, pixel!]) for (const cell of row.slice(1, -1)) expect(cell, row[0]).not.toMatch(/프로|울트라|플러스|S27\+/)
  expect(galaxy![1]).toBe('미발표, 예상 기본형 999달러(약 134만 원)부터')
  expect(iphone![1]).toBe('미발표')
  expect(iphone![2]).toBe('일반형은 2027년 봄 예상')
  expect(pixel![1]).toBe('999유로부터(기본 모델)')
  expect(out).toContain('[머니투데이](https://www.mt.co.kr/tech/2026/10/20/2026101915464770051)')
  // c10a r2 (Codex r1): the row is the base model, so the Pro pages (apple.com/…/iphone-18-pro, the blog and the short that only give the
  // Pro price) are not its source; the page that says the base model comes in spring 2027 is.
  expect(iphone!.at(-1)).toBe('[네이버 카페](https://cafe.naver.com/hiric)')
  // 출처 stays only for a host nothing knows (vidabytes: a piece of the address is never a name, c7).
  expect([...out.matchAll(/\[출처\]\((https?:\/\/[^/)]+)/g)].map(found => found[1])).toEqual(['https://ko.vidabytes.com'])
})

test('c10a R2: a tier the person named stays; a cell of another tier only says the base model was not found; a known outlet is named', () => {
  expect(oneTier('프로 기준 199만 원부터', '아이폰 18 프로 아이폰 18 프로의 가격 조사')).toBe('프로 기준 199만 원부터')
  expect(oneTier('프로 기준 199만 원부터', '아이폰 18 아이폰 18의 가격 조사')).toBe('기본형은 못 찾았어요')
  expect(oneTier('미발표 (전작 아이폰 17 129만 원)', '아이폰 18')).toBe('미발표 (전작 아이폰 17 129만 원)')
  expect(oneTier('미발표, 예상 999달러, S27+는 1199달러', '갤럭시 S27')).toBe('미발표, 예상 999달러')
  expect(oneTier('140만 3,600원', '갤럭시 S27')).toBe('140만 3,600원')
  for (const [url, name] of [['https://news.mt.co.kr/mtview.php?no=1', '머니투데이'], ['https://www.asiae.co.kr/article/1', '아시아경제'], ['https://biz.chosun.com/it/1', '조선비즈'], ['https://www.chosun.com/economy/1', '조선일보'], ['https://www.yna.co.kr/view/1', '연합뉴스']] as const)
    expect(sourceName(url, true), url).toBe(name)
  // With nothing known of the site, the plain word stays.
  expect(sourceName('https://unknown-site.example/a', true)).toBe('출처')
})

// c10a r2 (Codex r1): a source of another tier never stands beside a base-model row. Wordings and products not in the harness.
test('c10a r2: a base-model row links a page about the base model; a page only about another tier never; a named tier keeps its page', () => {
  const member = (role: string, brief: string, result: string): TeamMember => ({ id: role, parentId: null, depth: 1, role, brief, sessionKey: role, hiredAt: '2026-11-17T00:00:00Z', state: 'released', lookup: true, sources: ['https://search.naver.com/search.naver?query=x'], result })
  const watch = member('watch', '갤럭시 워치 9 가격', '가격: 워치 9 울트라 89만 원부터 — https://news.example.kr/watch9-ultra\n워치 9 기본형은 39만 원부터예요 — https://shop.example.kr/item/77')
  const pad = member('pad', '아이패드 13 가격', '아이패드 13 맥스 모델이 149만 원이에요. — https://blog.example.kr/p/1')
  const named = member('pro', '맥북 프로 15 가격', '맥북 프로 15는 299만 원부터 — https://www.example.com/macbook-pro-15')
  const table = ['| 제품 | 가격 | 출처 |', '|---|---|---|', '| 갤럭시 워치 9 | 39만 원부터, 울트라 89만 원 | [출처](https://news.example.kr/watch9-ultra) |', '| 아이패드 13 | 맥스 149만 원 | [블로그](https://blog.example.kr/p/1) |', '| 맥북 프로 15 | 299만 원부터 | 출처 |'].join('\n')
  const out = rows2(citeMembers(table, [watch, pad, named], true))
  expect(out[0]).toEqual(['갤럭시 워치 9', '39만 원부터', expect.stringContaining('(https://shop.example.kr/item/77)')])
  // The only page is about another tier: the teammate's search page stands instead.
  expect(out[1]![2]).toContain('https://search.naver.com/search.naver?query=x')
  expect(out[2]![2]).toContain('https://www.example.com/macbook-pro-15')
})
const rows2 = (text: string): string[][] => text.split('\n').filter(line => /^\| (갤럭시|아이패드|맥북)/.test(line)).map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))

// c10a r2 (Codex r1): a site on no list is named by what it calls itself in its page head, read while its link is checked. Hosts not in the harness.
test('c10a r2: a site\'s declared name names its link; nothing declared, or no name-like declaration, stays 출처', async () => {
  keepDeclaredName('https://www.gadgetnara.example/a/1', '<head><title>x</title><meta content="가젯나라" property="og:site_name"></head>')
  keepDeclaredName('https://m.techpulse.example/p', "<meta name='application-name' content='TechPulse'>")
  keepDeclaredName('https://longname.example/', '<meta property="og:site_name" content="2026 최고의 리뷰 사이트 모음 그리고 더">')
  keepDeclaredName('https://home.example/', '<meta property="og:site_name" content="Home">')
  expect(sourceName('https://gadgetnara.example/a/2', true)).toBe('가젯나라')
  expect(sourceName('https://techpulse.example/p', true)).toBe('TechPulse')
  expect(sourceName('https://longname.example/x', true)).toBe('출처')
  expect(sourceName('https://home.example/x', true)).toBe('출처')
  // The check reads only the head, and a link the citing named 출처 takes the declared name once its page answered.
  const html = new Response('<html><head><meta property="og:site_name" content="폰리뷰랩"></head><body>' + 'x'.repeat(200_000) + '</body></html>')
  const answer = '픽셀 12는 899달러부터예요. [출처](https://phonelab.example/pixel-12)'
  const out = await liveLinks(answer, [], async url => { keepDeclaredName(url, await pageHead(html.body, 4_096)); return true }, true)
  expect(out).toBe('픽셀 12는 899달러부터예요. [폰리뷰랩](https://phonelab.example/pixel-12)')
})

// c10a r3 (Codex r2): a source cell with two real links returned before the tier check, so another tier's page stayed beside a base row.
test('c10a r3: a base row\'s source cell of several links drops each page of another tier; all of another tier falls back like one link', () => {
  const member = (role: string, brief: string, result: string): TeamMember => ({ id: role, parentId: null, depth: 1, role, brief, sessionKey: role, hiredAt: '2026-11-17T00:00:00Z', state: 'released', lookup: true, sources: ['https://search.naver.com/search.naver?query=y'], result })
  const buds = member('buds', '갤럭시 버즈 5 가격', '버즈 5는 22만 원부터 — https://news.example.kr/buds5\n버즈 5 프로는 31만 원 — https://review.example.kr/buds-5-pro')
  const ipad = member('ipad', '아이패드 에어 8 가격', '에어 8 울트라 모델 129만 원 — https://blog.example.kr/air8-a\n에어 8 맥스는 139만 원 — https://blog.example.kr/air8-b')
  const table = ['| 제품 | 가격 | 출처 |', '|---|---|---|',
    '| 갤럭시 버즈 5 | 22만 원부터 | [뉴스](https://news.example.kr/buds5) · [리뷰](https://review.example.kr/buds-5-pro) |',
    '| 아이패드 에어 8 | 미발표 | [블로그](https://blog.example.kr/air8-a) · [블로그](https://blog.example.kr/air8-b) |'].join('\n')
  const out = rows2(citeMembers(table, [buds, ipad], true))
  expect(out[0]![2]).toContain('https://news.example.kr/buds5')
  expect(out[0]![2]).not.toContain('buds-5-pro')
  expect(out[1]![2]).not.toMatch(/air8-a|air8-b/)
  expect(out[1]![2]).toContain('https://search.naver.com/search.naver?query=y')
})
