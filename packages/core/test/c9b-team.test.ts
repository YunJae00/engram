import { beforeEach, expect, test, vi } from 'vitest'
import { firstFound, firstSearches, makerFirst, makerOf, mergedReport, searchWords } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { foundNothing } from '../src/team-hire-tools.js'

// c9b: the named team's thread (C3–C10, H5). Days are read against the run's week.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-11-17T03:00:00Z') }) })

const firsts = (brief: string, about = brief) => firstSearches({ brief, query: searchWords(brief, new Date(), about) }, about)

test('c9 fix 1: a job about a named product opens with the news search and the maker\'s own updates page, by its Latin name', () => {
  const slack = firsts('이번 주 슬랙 신기능 조사', '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘')
  expect(slack).toEqual([{ query: '슬랙 앱 새 기능 업데이트', news: true }, { query: 'Slack release notes', maker: 'Slack' }])
  expect(firsts('지난주 피그마 업데이트 뭐 있었어?')[1]).toEqual({ query: 'Figma release notes', maker: 'Figma' })
  // No period word: the job's words are searched as they are, not as news.
  expect(firsts('디스코드 새 기능')).toEqual([{ query: '디스코드 새 기능 업데이트' }, { query: 'Discord patch notes', maker: 'Discord' }])
  // The person's own Latin name wins over the list, and a product off the list is searched by it.
  expect(makerOf('리니어', '경쟁사 리니어(Linear) 조사')).toEqual({ name: 'Linear', query: 'Linear changelog' })
  expect(firsts('이번 주 플로우잇(Flowit) 신기능 조사')[1]).toEqual({ query: 'Flowit changelog', maker: 'Flowit' })
  // An unknown product gets the one search.
  expect(firsts('이번 주 모아보기 앱 신기능 조사')).toHaveLength(1)
  // Never two of the same words, never more than two first searches, never a relative time in the words.
  for (const brief of ['이번 주 노션 신기능 조사', '오늘 슬랙 새 기능 조사', '다음 달 서울 IT 행사 일정 정리']) {
    const all = firsts(brief)
    expect(all.length).toBeLessThanOrEqual(2)
    expect(new Set(all.map(one => one.query.toLowerCase())).size).toBe(all.length)
    expect(all.map(one => one.query).join(' ')).not.toMatch(/이번\s?주|오늘|다음\s?달/u)
  }
})

test('c9 fix 3: a list job is searched twice in different words; a plain lookup once', () => {
  const events = firsts('다음 달 서울 IT 행사 일정 정리')
  expect(events).toHaveLength(2)
  expect(events[1]!.query).toMatch(/컨퍼런스 세미나 밋업/)
  expect(firsts('부산 맛집 목록 정리')[1]!.query).toMatch(/식당 추천/)
  expect(firsts('이번 주말 서울 날씨 찾아봐')).toHaveLength(1)
})

test('c9 fix 1: the maker\'s own rows come first and are said so to the teammate', () => {
  const found = 'results for "Linear changelog" at https://www.bing.com/search?q=Linear+changelog (DATA)\n- Linear actuator guide — https://example.com/actuator — motors\n- Changelog — https://linear.app/changelog — Nov 13, 2026 — Agents in Linear'
  const out = makerFirst(found, 'Linear')
  expect(out.own).toBe(true)
  expect(out.found.split('\n')[1]).toContain('linear.app/changelog')
  expect(makerFirst('results for "x" at https://a.b (DATA)\n- A — https://example.com/a — a', 'Linear').own).toBe(false)
  const told = firstFound([{ query: '리니어 앱 새 기능 업데이트', news: true, found: 'results for "a"' }, { query: 'Linear changelog', maker: 'Linear', ...out }])
  expect(told).toContain('read_pages')
  expect(told).toContain('이번 주엔 새로 낸 게 없어요')
})

const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '서연', brief: '이번 주 슬랙 신기능 조사', state: 'done', sessionKey: 'k', hiredAt: '2026-11-17T02:59:00Z', lookup: true, botId: 'b1', ...over })

test('c9 fix 1: a teammate who describes the results page is not shown saying it', () => {
  const parts = [
    member({ id: 'm1', role: '지민', topic: '노션', brief: '이번 주 노션 신기능 조사', result: '노션은 11월 12일에 AI 회의록 요약을 냈어요. https://www.notion.com/releases' }),
    member({ id: 'm2', role: '서연', topic: '슬랙', result: '슬랙은 검색 결과가 사용법이랑 다운로드 안내 글들뿐이었어요. https://search.naver.com/search.naver?query=x' }),
    member({ id: 'm3', role: '도윤', topic: '리니어', brief: '이번 주 리니어 신기능 조사', result: '리니어도 검색에서 무관한 액추에이터나 다른 앱들만 나왔어요. https://search.naver.com/search.naver?query=y' }),
  ]
  const text = mergedReport(parts, new Map(), [], { ask: '이번 주 경쟁사 3곳(노션, 슬랙, 리니어) 신기능 조사해서 알려줘. 지민, 서연, 도윤한테 나눠서 시켜' })
  expect(text).not.toMatch(/검색 결과가|검색에서 무관/u)
  for (const word of ['노션', '슬랙', '리니어', '지민', '서연', '도윤']) expect(text).toContain(word)
  // The record reads "안 잡히더라고요" as found-nothing too (c9 C10: the summary writer was refused for saying so).
  expect(foundNothing('이번 주 기준으로는 슬랙 신기능 관련 구체적인 소식이 안 잡히더라고요!')).toBe(true)
})
