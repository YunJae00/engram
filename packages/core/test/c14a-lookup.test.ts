import { describe, expect, it } from 'vitest'
import { checkedSearch, judgedItems, LOOKUP_RESERVE_MS, WIDEN_MS } from '../src/item-check.js'
import { TEAM_ANSWER_MS } from '../src/team-hire-tools.js'
import type { AgentTool } from '../src/agent-loop.js'

const ASK = '요즘 국내 바이오 스타트업 인수합병 소식 4개'
const page = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const row = (n: number, title: string): string => `- ${title} — https://news.example/${n} — 인수합병 — 11월 ${n}일`
function search(outs: string[], tick?: () => void): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); tick?.(); return outs.shift() ?? '' } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)

describe('c14a: a counted lookup looks further on the one deadline', () => {
  it('4 rows seen for 4 asked: no further search, every row (sure or not) goes to the reader', async () => {
    const s = search([
      page('바이오 스타트업 인수합병', [row(1, '젠큐어, 바이오벤처 셀로직 인수'), row(2, '메디노바, 진단 스타트업 합병 완료'), row(3, '바이오 업계, 인수합병 바람 부나'), row(4, '바이오 투자 혹한기 계속')]),
      page('바이오벤처 M&A 인수', [row(5, '하이젠, AI 신약 스타트업 품었다'), row(6, '오가닉스, 플랫폼 기업 지분 100% 인수')]),
    ])
    const verdicts = ['{"keep":[1,2],"unsure":[3],"same":[],"search":"바이오벤처 M&A 인수"}', '{"keep":[1,2,4,5],"unsure":[3],"same":[],"search":""}']
    const out = await checkedSearch(s, { ask: () => ASK, write: async () => verdicts.shift(), since: 0, now: () => 0 }).run({ query: '바이오 스타트업 인수합병' }, { task: ASK })
    expect(s.queries).toEqual(['바이오 스타트업 인수합병'])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4'])
    expect(out).not.toMatch(/of these rows are from the period asked/)
  })

  it('keeps looking while rows are short and a round fits; stops once the rows seen reach the number; unsure rows are shown', async () => {
    let t = 0
    const s = search([page('a', [row(1, '알파바이오, 베타랩 인수'), row(2, '바이오 M&A 시장 전망')]), page('b', [row(3, '감마젠, 델타 합병'), row(4, '업계 재편 신호')]), page('c', [row(5, '엡실론, 제타 지분 인수')])], () => { t += 7_000 })
    const verdicts = ['{"keep":[1],"unsure":[2],"search":"b"}', '{"keep":[1,3],"unsure":[2,4],"search":"c"}', '{"keep":[1,2],"unsure":[3,4],"search":"d"}']
    const out = await checkedSearch(s, { ask: () => ASK, write: async () => verdicts.shift(), since: 0, now: () => t }).run({ query: 'a' }, { task: ASK })
    expect(TEAM_ANSWER_MS - LOOKUP_RESERVE_MS).toBe(20_000)
    expect(s.queries).toEqual(['a', 'b'])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4'])
    expect(out).not.toMatch(/may not be quite|of these rows are from the period asked/)
    expect(out).not.toMatch(/search no more|first sentence|Only \d/)
  })

  it('when the judge repeats its words or has none, the ask\'s own words are tried once; never the same words twice; the count is then said plainly', async () => {
    const s = search([page('x', [row(1, '알파바이오, 베타랩 인수')]), page('y', [row(2, '감마젠, 델타 합병')])])
    const verdicts = ['{"keep":[1],"search":"y"}', '{"keep":[1,2],"search":"y"}']
    const out = await checkedSearch(s, { ask: () => ASK, write: async () => verdicts.shift(), since: 0, now: () => 0 }).run({ query: 'x' }, { task: ASK })
    expect(s.queries).toEqual(['x', 'y', ASK])
    expect(new Set(s.queries).size).toBe(s.queries.length)
    expect(out).toContain('2 of these rows are from the period asked, for the 4 asked')
  })

  it('rows stay in the search\'s order and none is dropped as unsure', async () => {
    const s = search([page('x', [row(1, '바이오 투자 동향'), row(2, '알파, 베타 인수'), row(3, '감마, 델타 합병'), row(4, '엡실론, 제타 인수'), row(5, '이타, 세타 합병')])])
    const out = await checkedSearch(s, { ask: () => '바이오 인수합병 소식 3개', write: async () => '{"keep":[2,3,5],"unsure":[1],"search":""}', since: 0, now: () => 0 }).run({ query: 'x' }, { task: '' })
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4', 'https://news.example/5'])
  })

  it('the deadline is the one clock: the turn that began 15 s ago still widens (the fixed 15 s clock would not)', async () => {
    const s = search([page('x', [row(1, '알파, 베타 인수')]), page('y', [row(2, '감마, 델타 합병')])])
    const verdicts = ['{"keep":[1],"search":"y"}', '{"keep":[1,2],"search":""}']
    await checkedSearch(s, { ask: () => '바이오 인수합병 두 건만 알려줘 2개', write: async () => verdicts.shift(), since: 0, now: () => TEAM_ANSWER_MS - LOOKUP_RESERVE_MS - WIDEN_MS }).run({ query: 'x' }, { task: '' })
    expect(s.queries).toEqual(['x', 'y'])
  })

  it('a stopped turn starts no further round', async () => {
    const stop = new AbortController()
    const s = search([page('x', [row(1, '알파, 베타 인수')]), page('y', [row(2, '감마, 델타 합병')])])
    stop.abort()
    await checkedSearch(s, { ask: () => ASK, write: async () => '{"keep":[1],"search":"y"}', since: 0, now: () => 0 }).run({ query: 'x' }, { task: ASK, signal: stop.signal })
    expect(s.queries).toEqual(['x'])
  })

  it('judgedItems: unsure is its own field, never both kept and unsure; the prompt no longer keeps what it cannot tell', async () => {
    let prompt = ''
    const said = await judgedItems('제주 신규 카페 개업 소식 3개', [{ text: 'a' }, { text: 'b' }, { text: 'c' }], async p => { prompt = p; return '{"keep":[1,2],"unsure":[2,3,9]}' }, 1000, { tried: [] })
    expect(said).toMatchObject({ keep: [1, 2], unsure: [3] })
    expect(prompt).toContain('it is not kept: put its number in "unsure" instead')
    expect(prompt).not.toContain('keep it.')
    expect(prompt).toContain('"unsure": [<n>]')
  })
})

describe('kindChecked with entries in hand', () => {
  it('keeps an item the judge calls the same as one in hand when its words differ (c19a r3 #1), and renumbers lists and names', async () => {
    const { kindChecked, withItems } = await import('../src/company-tools.js')
    const PAGE = 'https://hall.example.kr/gwangju/winter'
    const inHand = [{ text: '광주 시립 합창단 송년 음악회 12월 20일', url: PAGE, site: '시립', date: '12월 20일' }]
    const more = { facts: [
      { text: '시립 합창단 송년회 공연, 12월 20일 저녁', url: PAGE, site: '시립', date: '12월 20일' },
      { text: '광주 청소년 국악 발표회 1월 10일', url: PAGE, site: '시립', date: '1월 10일' },
      { text: '광주 겨울 공연 모음', url: 'https://hall.example.kr/gwangju', site: '시립' },
    ] }
    let seen = ''
    const out = await kindChecked(more, '광주 겨울 공연 일정', async prompt => { seen = prompt; return '{"keep":[1,2,3,4],"same":[[1,2]],"lists":[4],"names":{"3":"국악 발표회","4":"공연 모음"}}' }, 1000, inHand)
    expect(seen).toContain('"n":1,"text":"광주 시립 합창단 송년 음악회 12월 20일"')
    expect(out?.facts.map(f => [f.text, f.name ?? '', f.listing ?? false])).toEqual([['시립 합창단 송년회 공연, 12월 20일 저녁', '', false], ['광주 청소년 국악 발표회 1월 10일', '국악 발표회', false], ['광주 겨울 공연 모음', '공연 모음', true]])
    const merged = withItems({ facts: [...inHand, { text: '겨울 공연 목록', url: 'https://hall.example.kr/list', site: '시립', listing: true }] }, { facts: [out!.facts[1]!] })
    expect(merged.facts.map(f => f.text)).toEqual(['광주 시립 합창단 송년 음악회 12월 20일', '광주 청소년 국악 발표회 1월 10일', '겨울 공연 목록'])
  })
})
