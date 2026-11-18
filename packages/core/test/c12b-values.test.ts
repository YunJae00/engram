import { expect, it } from 'vitest'
import { citeMembers, liveCited, liveLinks, LOOKUP_RULE, memberPersona, MERGED_SHAPE, type TeamMember } from '../src/index.js'

const helper = (role: string, brief: string, result: string, sources: string[] = ['https://search.naver.com/search.naver?query=x']): TeamMember =>
  ({ id: role, parentId: null, depth: 1, role, brief, sessionKey: role, hiredAt: '2026-11-18T00:00:00Z', state: 'released', lookup: true, sources, result })

it('c12b: a helper\'s rule has no tier ban and no fixed "미발표" frame; values are labeled by what and whose they are', () => {
  for (const brief of ['모토로라 레이저 70의 가격과 출시일 조사', '낫싱 폰 4의 가격과 출시일 조사']) {
    const rule = memberPersona(helper('h', brief, ''))
    expect(rule).toContain(LOOKUP_RULE)
    expect(rule).not.toMatch(/프로, 울트라, 플러스|another tier|base model unless|not even in a bracket/)
    expect(rule).not.toMatch(/"미발표[,( ]/)
    expect(rule).toContain('a thing already out has its 출시가 and its date, never "미발표"')
    expect(rule).toContain('names what it belongs to')
    expect(rule).toContain('a price with its currency')
    expect(rule).toContain('A source is named by its site or publication')
  }
  expect(MERGED_SHAPE).toContain('Every concrete value a member reported stays in its row')
  expect(MERGED_SHAPE).toContain('says only what the cells below show')
  expect(MERGED_SHAPE).not.toMatch(/same tier|another tier|"미발표 \(/)
})

it('c12b: the merged table keeps every value its helpers reported, labeled, for an unreleased base model beside a released upper model and for a released phone', () => {
  const fold = helper('폴드', '갤럭시 Z 폴드 8의 가격과 출시일 조사', '기본형은 아직 미발표예요. 울트라는 지난달 출시됐어요.\n가격: 울트라 출시가 289만 원부터 (https://news.example.kr/fold8-ultra)\n출시일: 기본형 2027년 7월 예상 (https://news.example.kr/fold8)')
  const razr = helper('레이저', '모토로라 레이저 70의 가격과 출시일 조사', '가격: 출시가 129만 원 (https://moto.example.com/razr70)\n출시일: 2026년 6월 5일 (https://moto.example.com/razr70)')
  const table = ['둘 다 찾았어요. 폴드 8은 울트라만 나왔고, 레이저 70은 이미 출시됐어요.', '', '| 제품 | 가격 | 출시일 | 출처 |', '|---|---|---|---|',
    '| 갤럭시 Z 폴드 8 | 울트라 출시가 289만 원부터 | 기본형 2027년 7월 예상 | [뉴스](https://news.example.kr/fold8-ultra) |',
    '| 모토로라 레이저 70 | 출시가 129만 원 | 2026년 6월 5일 | [모토로라](https://moto.example.com/razr70) |'].join('\n')
  const out = citeMembers(table, [fold, razr], true)
  const rows = out.split('\n').filter(line => /^\| (갤럭시|모토로라)/.test(line)).map(line => line.slice(1, -1).split('|').map(cell => cell.trim()))
  expect(rows[0]!.slice(0, 3)).toEqual(['갤럭시 Z 폴드 8', '울트라 출시가 289만 원부터', '기본형 2027년 7월 예상'])
  expect(rows[1]!.slice(0, 3)).toEqual(['모토로라 레이저 70', '출시가 129만 원', '2026년 6월 5일'])
  expect(out).not.toContain('미발표')
  expect(out).not.toContain('못 찾았어요')
  for (const figure of ['289만 원', '2027년 7월', '129만 원', '2026년 6월 5일']) expect(out).toContain(figure)
  expect(rows[0]!.at(-1)).toContain('https://news.example.kr/fold8-ultra')
})

it('c12b: a table cell whose only link is dead shows no bare site name; a cell with another live link keeps that one', async () => {
  const alive = async (url: string): Promise<boolean> => !url.includes('gone.example')
  const table = ['| 제품 | 가격 | 출처 |', '|---|---|---|',
    '| 낫싱 폰 4 | 예상 79만 원 | [gadgetzone](https://gone.example/phone4) |',
    '| 샤오미 17 | 출시가 99만 원 | [gadgetzone](https://gone.example/mi17) · [샤오미](https://mi.example/17) |'].join('\n')
  const out = await liveLinks(table, [], alive, true, 500, [])
  expect(out).not.toContain('gadgetzone')
  expect(out).toContain('| 낫싱 폰 4 | 예상 79만 원 |  |')
  expect(out).toContain('| 샤오미 17 | 출시가 99만 원 | [샤오미](https://mi.example/17) |')
  const cited = await liveCited(table, [], answer => answer, alive, true, 500)
  expect(cited).not.toContain('gadgetzone')
  expect(cited).toContain('[샤오미](https://mi.example/17)')
  expect(await liveLinks('가젯존 리뷰에 따르면 79만 원이에요. [가젯존](https://gone.example/r)', [], alive, true, 500, [])).toBe('가젯존 리뷰에 따르면 79만 원이에요. 가젯존')
})
