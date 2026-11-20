import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { COLLEAGUE_CORE_RULE } from '../src/agent-voice.js'
import * as company from '../src/company-tools.js'
import { handBacks, partOutcome } from '../src/company-tools.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { keptItems, settleMember } from '../src/team-hire-tools.js'

const run = JSON.parse(readFileSync(new URL('./fixtures/c10b-stack9-team.json', import.meta.url), 'utf8')) as Record<'it' | 'notion' | 'slack' | 'linear', { brief: string; result: string; sources: string[] }>
const member = (over: Partial<TeamMember>): TeamMember => ({ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '', state: 'done', sessionKey: 'k', hiredAt: '2026-11-17T08:46:21Z', lookup: true, botId: 'b1', ...over })
const SEARCH = 'https://search.naver.com/search.naver?query=x'
interface Back { reports: { who: string; part?: string; state: string; result: string; sources?: string[] }[]; note: string }
const back = (members: TeamMember[]): Back => JSON.parse(handBacks(members)) as Back

test('c10b fix 1 → k1: a teammate cut off at its time hands back its own answer and what it read; a list item whose only link is a search page is left out of its result; nothing after the lead\'s answer checks or drops a line', () => {
  const [answer, ...rows] = run.it.result.replace(/\n\(시간 한도에서 멈춤[^)]*\)$/, '').split('\n')
  const coex = answer!.match(/https:\/\/\S+/)![0]
  const jimin = member({ brief: run.it.brief, voice: '차분하고 또박또박' })
  settleMember(jimin, { answer: answer!, read: rows.join('\n'), timedOut: true, sources: run.it.sources }, '2026-11-17T08:46:36Z', true)
  expect(jimin.data).toBeUndefined()
  expect(jimin.result!.startsWith(answer!)).toBe(true)
  expect(jimin.result).toContain('소프트웨이브 2026')
  expect(jimin.result).toMatch(/\n\(시간 한도에서 멈춤[^)]*\)$/)
  const handed = back([jimin]).reports[0]!
  expect(handed.result).toBe(jimin.result)
  expect(handed.result).toContain(coex)
  expect(handed.sources).toEqual(jimin.sources)
  expect(Object.entries(company).filter(([name, value]) => typeof value === 'function' && /report|answer|check|merge|written|kind|period/i.test(name)).map(([name]) => name).sort()).toEqual(['answersItself', 'employeesAnswer', 'setReportLog'])
  const listed = member({ brief: '다음 달 서울 IT 행사 일정 정리' })
  settleMember(listed, { answer: '12월 2일 소프트웨이브 https://www.coex.co.kr/a\n12월 9일 데브 밋업 https://search.naver.com/search.naver?query=x' }, 'now', true)
  expect(listed.result).toBe('12월 2일 소프트웨이브 https://www.coex.co.kr/a')
  const alone = member({ brief: '다음 달 서울 IT 행사 일정 정리' })
  settleMember(alone, { answer: '12월 24일 재즈 공연 https://example.com/a' }, 'now', true)
  expect(alone.data).toBeUndefined()
  expect(alone.result).toBe('12월 24일 재즈 공연 https://example.com/a')
  expect(partOutcome(alone)).toBe('found')
  const searched = member({ brief: '다음 달 서울 IT 행사 일정 정리' })
  settleMember(searched, { answer: '12월 9일 데브 밋업 https://search.naver.com/search.naver?query=x' }, 'now', true)
  expect(searched.result).toContain('데브 밋업')
  const one = member({ brief: '이번 주말 서울 공연 찾아줘' })
  settleMember(one, { answer: '12월 24일 재즈 공연이 있어요. https://example.com/a' }, 'now', true)
  expect(one.result).toContain('재즈 공연')
})

const c3 = (): TeamMember[] => [
  member({ id: 'a', role: '지민', topic: '노션', brief: run.notion.brief, result: run.notion.result, sources: run.notion.sources }),
  member({ id: 'b', role: '서연', topic: '슬랙', brief: run.slack.brief, result: run.slack.result, sources: run.slack.sources, botId: 'b2' }),
  member({ id: 'c', role: '도윤', topic: '리니어', brief: run.linear.brief, result: run.linear.result, sources: run.linear.sources, botId: 'b3' }),
]

test('c10b fix 2 and 3 → k1: the three stored parts reach the lead in order, each with its own words, its latest day and its page; Korean lines and translated headlines are the writer\'s rule', () => {
  const out = back(c3())
  expect(out.reports.map(r => [r.who, r.part])).toEqual([['지민', '노션'], ['서연', '슬랙'], ['도윤', '리니어']])
  expect(out.reports.map(r => r.result)).toEqual([run.notion.result, run.slack.result, run.linear.result])
  for (const [i, day] of ['2026년 10월 19일', '2026년 11월 9일', '11월 12일'].entries()) {
    expect(out.reports[i]!.result).toContain(day)
    expect(out.reports[i]!.result).toMatch(/https:\/\/\S+$/)
    expect(out.reports[i]!.sources).toEqual(c3()[i]!.sources)
  }
  expect(out.note).toContain('A headline or title a source wrote in another language is given in the person\'s language, not quoted in the original')
  expect(COLLEAGUE_CORE_RULE).toContain('In a Korean thread every line is Korean except names, code, addresses, file names')
  expect(COLLEAGUE_CORE_RULE).toContain('A part still being worked on, or one that found nothing, is said in one plain sentence in its place')
})

test('c10b r1 (Codex) → k1: a lone teammate\'s list reaches the lead with both links and every word, and the lead is told to put each source right after what it backs', () => {
  const result = '12월 6일 호밀빵 굽기 수업: sourdough starters for home bakers [동네빵집](https://bread.example.kr/class/6)\n12월 13일 케이크 장식 수업 [베이킹랩](https://lab.example.kr/cake/13)'
  const m = member({ brief: '다음 달 동네 제빵 수업 일정 정리', result, sources: ['https://bread.example.kr/class/6', 'https://lab.example.kr/cake/13'] })
  const out = back([m])
  expect(out.reports).toHaveLength(1)
  expect(out.reports[0]!.result).toBe(result)
  expect(out.reports[0]!.result.match(/\]\(https:\/\//g)).toHaveLength(2)
  expect(out.note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result')
  expect(out.note).toContain('A table only when the person asked to compare or for a table.')
})

test('c10b r2 (Codex): an item that runs over several lines goes or stays whole (c11a: dropped for a search-page-only link, not by kind)', () => {
  const brief = '이번 달 부산 AI 모임 목록 만들어줘'
  const text = `1) 12월 3일 부산 AI 해커톤\n   벡스코 제2전시장 https://bexco.example/hack\n2) 12월 10일 바이올린 리사이틀\n   영화의전당 12월 10일 저녁 ${SEARCH}\n12월 14일 오케스트라 공연\n   해운대 문화회관 ${SEARCH}\n- 12월 20일 클라우드 보안 밋업 https://meet.example/c`
  const kept = keptItems(brief, text)
  expect(kept).not.toMatch(/리사이틀|영화의전당|오케스트라|문화회관/)
  expect(kept).toBe('1) 12월 3일 부산 AI 해커톤\n   벡스코 제2전시장 https://bexco.example/hack\n- 12월 20일 클라우드 보안 밋업 https://meet.example/c')
  expect(keptItems('다음 달 서울 IT 행사 일정 정리', `12월 2일 소프트웨이브 https://www.coex.co.kr/a\n12월 24일 재즈 공연\n강동아트센터 12월 24일 ${SEARCH}`)).toBe('12월 2일 소프트웨이브 https://www.coex.co.kr/a')
})

test('c10b r2 (Codex) → k1: a part with nothing new in the time asked is handed back in its own words, counted as that outcome from its state, and never shown as still working or finished with a find', () => {
  const quiet = member({ id: 'f', role: '하린', topic: '산악회', brief: '이번 주 산악회 새 공지 찾아줘', empty: true, result: '이번 주엔 새 공지가 없었어요. 11월 3일 장비 점검 안내가 마지막이에요. https://club.example.kr/notice/3' })
  const busy = member({ id: 'g', role: '태오', topic: '걷기 모임', brief: '이번 주 걷기 모임 새 공지 찾아줘', state: 'working' })
  const empty = member({ id: 'h', role: '누리', topic: '자전거 모임', brief: '이번 주 자전거 모임 새 공지 찾아줘', data: { facts: [], nothing: {} }, result: '이번엔 새로 나온 게 없어요.' })
  expect([quiet, busy, empty].map(partOutcome)).toEqual(['found', 'working', 'nothing-in-period'])
  const out = back([quiet, busy, empty])
  expect(out.reports.map(r => [r.part, r.who, r.state, r.result])).toEqual([['산악회', '하린', 'done', quiet.result], ['걷기 모임', '태오', 'working', ''], ['자전거 모임', '누리', 'done', empty.result]])
  expect(out.reports[0]!.result).toContain('11월 3일')
  expect(out.reports[0]!.result).toContain('https://club.example.kr/notice/3')
})

test('stack-10 (c10b r3 Codex #2): a field bullet under an item ("- 장소: …") goes or stays with it, and is no item of its own (c11a: dropped for a search-page-only link, not by kind)', () => {
  const brief = '다음 달 부산 AI 행사 목록 정리'
  const kept = keptItems(brief, `- 12월 3일 부산 AI 해커톤 https://ai.example/hack\n- 장소: 벡스코 제2전시장\n- 12월 18일 겨울 클래식 콘서트\n- 장소: 부산문화회관 ${SEARCH}\n- 요금: 3만 원`)
  expect(kept).toBe('- 12월 3일 부산 AI 해커톤 https://ai.example/hack\n- 장소: 벡스코 제2전시장')
  expect(keptItems('다음 달 서울 IT 행사 일정 정리', `- 12월 2일 소프트웨이브 https://www.coex.co.kr/a\n- 12월 24일 재즈 공연\n- 장소: 강동아트센터 ${SEARCH}`)).toBe('- 12월 2일 소프트웨이브 https://www.coex.co.kr/a')
  expect(keptItems(brief, '- 12월 3일 부산 AI 해커톤 https://ai.example/hack\n- 밋업: 12월 10일 클라우드 보안 밋업 https://sec.example/m')).toContain('클라우드 보안 밋업')
})
