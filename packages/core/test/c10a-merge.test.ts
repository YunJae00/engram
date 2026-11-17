import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { citeMembers, keepDeclaredName, liveLinks, pageHead, sourceName, type TeamMember } from '../src/index.js'

// c12b: the host's tier filter (oneTier) is gone: a value cell comes out of the merge exactly as the lead wrote it, whatever model it names.
const oneTier = (cell: string, row: string): string => {
  const helper: TeamMember = { id: 'h', parentId: null, depth: 1, role: row.split(' ').slice(0, 2).join(''), brief: row, sessionKey: 'h', hiredAt: '2026-11-17T00:00:00Z', state: 'released', lookup: true, sources: ['https://search.naver.com/search.naver?query=z'], result: `가격: ${cell}` }
  const line = citeMembers(['| 제품 | 가격 | 출처 |', '|---|---|---|', `| ${row.split(' ').slice(0, 2).join(' ')} | ${cell} | 출처 |`].join('\n'), [helper], true).split('\n')[2]!
  return line.slice(1, -1).split('|').map(one => one.trim())[1]!
}

// The stack-9 run's R2 helpers (runs/stack9-b685945e tasks.json, t-mwkfyhd4-586409) and the table the lead wrote from them.
const r2 = JSON.parse(readFileSync(new URL('./fixtures/c10a-r2-helpers.json', import.meta.url), 'utf8')) as { members: TeamMember[] }
const table = ['셋이 하나씩 맡아서 알아봤어요.', '', '| 제품 | 가격 | 출시일 | 출처 |', '|---|---|---|---|',
  '| 아이폰 18 | 미발표, 프로 기준 199만 원부터(256GB) | 일반형은 2027년 봄 예상 (프로는 이미 출시) | [네이버 블로그](https://blog.naver.com/automobile1004/224479601593) |',
  '| 갤럭시 S27 | 미발표, 예상 기본형 999달러(약 134만 원)부터, 울트라 약 187만 원부터 | 미발표, 2027년 1~2월 언팩 예상 | [출처](https://www.mt.co.kr/tech/2026/10/20/2026101915464770051) |',
  '| 픽셀 11 | 999유로부터(기본 모델) | 2026년 8월 12일 | [위키백과](https://ko.wikipedia.org/wiki/%ED%94%BD%EC%85%80_11_%ED%94%84%EB%A1%9C) |'].join('\n')
const rows = (text: string): string[][] => text.split('\n').filter(line => /^\| (아이폰|갤럭시|픽셀)/.test(line)).map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))

test('c10a R2 (c12b: every value stays, labeled): the stored helpers through the merge keep each tier-labeled value and no link named 출처 on a known host (c11a: an unknown host by its host)', () => {
  const out = citeMembers(table, r2.members, true), [iphone, galaxy, pixel] = rows(out)
  // c12b: the 프로 / 울트라 values the lead labeled stay in their cells; the host cuts no value for being another model's.
  expect(galaxy![1]).toBe('미발표, 예상 기본형 999달러(약 134만 원)부터, 울트라 약 187만 원부터')
  expect(iphone![1]).toBe('미발표, 프로 기준 199만 원부터(256GB)')
  expect(iphone![2]).toBe('일반형은 2027년 봄 예상 (프로는 이미 출시)')
  expect(pixel![1]).toBe('999유로부터(기본 모델)')
  expect(out).toContain('[머니투데이](https://www.mt.co.kr/tech/2026/10/20/2026101915464770051)')
  // c12b: the row shows the Pro price, so the page that holds it may stay its source (c10a r2 kept only a base-model page).
  expect(iphone!.at(-1)).toBe('[네이버 블로그](https://blog.naver.com/automobile1004/224479601593)')
  // c11a: no link is named 출처; a host nothing knows is named by its host as written (vidabytes: a piece of the address is never a name, c7).
  expect(out).not.toMatch(/\[출처\]/)
  expect([...out.matchAll(/\[ko\.vidabytes\.com\]\((https?:\/\/[^/)]+)/g)].map(found => found[1])).toEqual(['https://ko.vidabytes.com'])
})

test('c10a R2 (c12b): a cell naming any tier stays as the lead wrote it; a known outlet is named (c11a: an unknown site by its host)', () => {
  expect(oneTier('프로 기준 199만 원부터', '아이폰 18 프로 아이폰 18 프로의 가격 조사')).toBe('프로 기준 199만 원부터')
  expect(oneTier('프로 기준 199만 원부터', '아이폰 18 아이폰 18의 가격 조사')).toBe('프로 기준 199만 원부터')
  expect(oneTier('미발표 (전작 아이폰 17 129만 원)', '아이폰 18')).toBe('미발표 (전작 아이폰 17 129만 원)')
  expect(oneTier('미발표, 예상 999달러, S27+는 1199달러', '갤럭시 S27')).toBe('미발표, 예상 999달러, S27+는 1199달러')
  expect(oneTier('140만 3,600원', '갤럭시 S27')).toBe('140만 3,600원')
  for (const [url, name] of [['https://news.mt.co.kr/mtview.php?no=1', '머니투데이'], ['https://www.asiae.co.kr/article/1', '아시아경제'], ['https://biz.chosun.com/it/1', '조선비즈'], ['https://www.chosun.com/economy/1', '조선일보'], ['https://www.yna.co.kr/view/1', '연합뉴스']] as const)
    expect(sourceName(url, true), url).toBe(name)
  // c11a: with nothing known of the site, its host names it, never the word 출처.
  expect(sourceName('https://unknown-site.example/a', true)).toBe('unknown-site.example')
})

// c10a r2 (Codex r1): a source of another tier never stands beside a base-model row. Wordings and products not in the harness.
test('c10a r2 (c12b: values of another model stay, labeled, and so does the page they came from): each row keeps its values and a page its teammate cited', () => {
  const member = (role: string, brief: string, result: string): TeamMember => ({ id: role, parentId: null, depth: 1, role, brief, sessionKey: role, hiredAt: '2026-11-17T00:00:00Z', state: 'released', lookup: true, sources: ['https://search.naver.com/search.naver?query=x'], result })
  const watch = member('watch', '갤럭시 워치 9 가격', '가격: 워치 9 울트라 89만 원부터 — https://news.example.kr/watch9-ultra\n워치 9 기본형은 39만 원부터예요 — https://shop.example.kr/item/77')
  const pad = member('pad', '아이패드 13 가격', '아이패드 13 맥스 모델이 149만 원이에요. — https://blog.example.kr/p/1')
  const named = member('pro', '맥북 프로 15 가격', '맥북 프로 15는 299만 원부터 — https://www.example.com/macbook-pro-15')
  const table = ['| 제품 | 가격 | 출처 |', '|---|---|---|', '| 갤럭시 워치 9 | 39만 원부터, 울트라 89만 원 | [출처](https://news.example.kr/watch9-ultra) |', '| 아이패드 13 | 맥스 149만 원 | [블로그](https://blog.example.kr/p/1) |', '| 맥북 프로 15 | 299만 원부터 | 출처 |'].join('\n')
  const out = rows2(citeMembers(table, [watch, pad, named], true))
  expect(out[0]).toEqual(['갤럭시 워치 9', '39만 원부터, 울트라 89만 원', expect.stringContaining('(https://news.example.kr/watch9-ultra)')])
  // c12b: the 맥스 value is shown labeled, so the page that holds it is the row's source, not a search page.
  expect(out[1]).toEqual(['아이패드 13', '맥스 149만 원', expect.stringContaining('(https://blog.example.kr/p/1)')])
  expect(out[1]![2]).not.toContain('search.naver.com')
  expect(out[2]![2]).toContain('https://www.example.com/macbook-pro-15')
})
const rows2 = (text: string): string[][] => text.split('\n').filter(line => /^\| (갤럭시|아이패드|맥북)/.test(line)).map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))

// c10a r2 (Codex r1): a site on no list is named by what it calls itself in its page head, read while its link is checked. Hosts not in the harness.
test('c10a r2: a site\'s declared name names its link; nothing declared, or no name-like declaration, stays 출처 (c11a: the host, never 출처)', async () => {
  keepDeclaredName('https://www.gadgetnara.example/a/1', '<head><title>x</title><meta content="가젯나라" property="og:site_name"></head>')
  keepDeclaredName('https://m.techpulse.example/p', "<meta name='application-name' content='TechPulse'>")
  keepDeclaredName('https://longname.example/', '<meta property="og:site_name" content="2026 최고의 리뷰 사이트 모음 그리고 더">')
  keepDeclaredName('https://home.example/', '<meta property="og:site_name" content="Home">')
  expect(sourceName('https://gadgetnara.example/a/2', true)).toBe('가젯나라')
  expect(sourceName('https://techpulse.example/p', true)).toBe('TechPulse')
  // c11a: no name-like declaration: the host, never 출처.
  expect(sourceName('https://longname.example/x', true)).toBe('longname.example')
  expect(sourceName('https://home.example/x', true)).toBe('home.example')
  // The check reads only the head, and a link the citing named 출처 takes the declared name once its page answered.
  const html = new Response('<html><head><meta property="og:site_name" content="폰리뷰랩"></head><body>' + 'x'.repeat(200_000) + '</body></html>')
  const answer = '픽셀 12는 899달러부터예요. [출처](https://phonelab.example/pixel-12)'
  const out = await liveLinks(answer, [], async url => { keepDeclaredName(url, await pageHead(html.body, 4_096)); return true }, true)
  expect(out).toBe('픽셀 12는 899달러부터예요. [폰리뷰랩](https://phonelab.example/pixel-12)')
})

// c10a r3 (Codex r2): a source cell with two real links returned before the tier check, so another tier's page stayed beside a base row.
test('c10a r3 (c12b: no page is dropped for being another model\'s): a source cell of several real links keeps each', () => {
  const member = (role: string, brief: string, result: string): TeamMember => ({ id: role, parentId: null, depth: 1, role, brief, sessionKey: role, hiredAt: '2026-11-17T00:00:00Z', state: 'released', lookup: true, sources: ['https://search.naver.com/search.naver?query=y'], result })
  const buds = member('buds', '갤럭시 버즈 5 가격', '버즈 5는 22만 원부터 — https://news.example.kr/buds5\n버즈 5 프로는 31만 원 — https://review.example.kr/buds-5-pro')
  const ipad = member('ipad', '아이패드 에어 8 가격', '에어 8 울트라 모델 129만 원 — https://blog.example.kr/air8-a\n에어 8 맥스는 139만 원 — https://blog.example.kr/air8-b')
  const table = ['| 제품 | 가격 | 출처 |', '|---|---|---|',
    '| 갤럭시 버즈 5 | 22만 원부터 | [뉴스](https://news.example.kr/buds5) · [리뷰](https://review.example.kr/buds-5-pro) |',
    '| 아이패드 에어 8 | 미발표 | [블로그](https://blog.example.kr/air8-a) · [블로그](https://blog.example.kr/air8-b) |'].join('\n')
  const out = rows2(citeMembers(table, [buds, ipad], true))
  expect(out[0]![2]).toContain('https://news.example.kr/buds5')
  expect(out[0]![2]).toContain('buds-5-pro')
  expect(out[1]![2]).toMatch(/air8-a[^]*air8-b/)
  expect(out[1]![2]).not.toContain('https://search.naver.com/search.naver?query=y')
})

test('stack-10 (c10a r3; c12b): a tier bracket and the price it labels stay in the cell, so the value says whose it is', () => {
  expect(oneTier('199만 원부터 (프로 기준)', '아이폰 18')).toBe('199만 원부터 (프로 기준)')
  expect(oneTier('미발표 (예상 89만 원대), 129만 원부터 (울트라 모델)', '갤럭시 탭 S12')).toBe('미발표 (예상 89만 원대), 129만 원부터 (울트라 모델)')
  expect(oneTier('109만 원 (울트라는 159만 원)', '갤럭시 탭 S12')).toBe('109만 원 (울트라는 159만 원)')
  expect(oneTier('49만 원 (맥스 기준) / 39만 원 (기본형)', '에어팟')).toBe('49만 원 (맥스 기준) / 39만 원 (기본형)')
  expect(oneTier('129만 원 (프로 기준)', '맥북 프로')).toBe('129만 원 (프로 기준)')
})
test('stack-10 (c12b): a tier bracket that speaks about that tier stays beside the base figure', () => {
  expect(oneTier('69만 원부터 (울트라는 아직 미정)', '갤럭시 워치 9')).toBe('69만 원부터 (울트라는 아직 미정)')
  expect(oneTier('69만 원부터 (울트라 모델)', '갤럭시 워치 9')).toBe('69만 원부터 (울트라 모델)')
})
