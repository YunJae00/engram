import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { citeMembers, oneTier, sourceName, type TeamMember } from '../src/index.js'

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
  // A short video ranks below the maker's page (c10a: Naver shorts are videos too).
  expect(iphone!.at(-1)).toBe('[Apple](https://www.apple.com/kr/iphone-18-pro/)')
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
