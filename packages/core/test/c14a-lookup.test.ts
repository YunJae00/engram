import { describe, expect, it } from 'vitest'
import { checkedSearch, judgedItems, LOOKUP_RESERVE_MS, WIDEN_MS } from '../src/item-check.js'
import { TEAM_ANSWER_MS } from '../src/team-hire-tools.js'
import type { AgentTool } from '../src/agent-loop.js'

// c14a (cause K: R3 3 of 5 at 14.3 s and H6 2 of 3 at 6.1 s, each with an off-kind row kept). A counted list looks further on the one
// deadline instead of a fixed 15 s and one extra round; a row the judge cannot tell is no fit; the shortfall is data. No harness wording.
const ASK = '요즘 국내 바이오 스타트업 인수합병 소식 4개'
const page = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const row = (n: number, title: string): string => `- ${title} — https://news.example/${n} — 인수합병 — 11월 ${n}일`
function search(outs: string[], tick?: () => void): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); tick?.(); return outs.shift() ?? '' } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)

describe('c14a: a counted lookup looks further on the one deadline', () => {
  it('2 sure + 1 unsure, then 2 more sure: 4 sure, the unsure one dropped, two searches in distinct words', async () => {
    const s = search([
      page('바이오 스타트업 인수합병', [row(1, '젠큐어, 바이오벤처 셀로직 인수'), row(2, '메디노바, 진단 스타트업 합병 완료'), row(3, '바이오 업계, 인수합병 바람 부나'), row(4, '바이오 투자 혹한기 계속')]),
      page('바이오벤처 M&A 인수', [row(5, '하이젠, AI 신약 스타트업 품었다'), row(6, '오가닉스, 플랫폼 기업 지분 100% 인수')]),
    ])
    // Round 2 is judged with the rows held: [1, 2, 3 (unsure), 5, 6].
    const verdicts = ['{"keep":[1,2],"unsure":[3],"same":[],"search":"바이오벤처 M&A 인수"}', '{"keep":[1,2,4,5],"unsure":[3],"same":[],"search":""}']
    const out = await checkedSearch(s, { ask: () => ASK, write: async () => verdicts.shift(), since: 0, now: () => 0 }).run({ query: '바이오 스타트업 인수합병' }, { task: ASK })
    expect(s.queries).toEqual(['바이오 스타트업 인수합병', '바이오벤처 M&A 인수'])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/5', 'https://news.example/6'])
    expect(out).toContain('They hold the 4 asked for: list 4 of them.')
  })

  it('keeps looking past one extra round while time is left; a slow clock stops it at the deadline, fills with unsure rows last', async () => {
    let t = 0
    // Each search takes 7 s of the clock: the rounds end once the next would run past the answer deadline less the writing reserve.
    const s = search([page('a', [row(1, '알파바이오, 베타랩 인수'), row(2, '바이오 M&A 시장 전망')]), page('b', [row(3, '감마젠, 델타 합병'), row(4, '업계 재편 신호')]), page('c', [row(5, '엡실론, 제타 지분 인수')])], () => { t += 7_000 })
    const verdicts = ['{"keep":[1],"unsure":[2],"search":"b"}', '{"keep":[1,3],"unsure":[2,4],"search":"c"}', '{"keep":[1,2],"unsure":[3,4],"search":"d"}']
    const out = await checkedSearch(s, { ask: () => ASK, write: async () => verdicts.shift(), since: 0, now: () => t }).run({ query: 'a' }, { task: ASK })
    // Round 3 lists the held rows sure first: [1, 3, 2 (unsure), 4 (unsure), 5].
    // 7 s: a round fits (7 + 6 <= 20); 14 s: still (14 + 6 <= 20); 21 s: no more.
    expect(TEAM_ANSWER_MS - LOOKUP_RESERVE_MS).toBe(20_000)
    expect(s.queries).toEqual(['a', 'b', 'c'])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/3', 'https://news.example/2', 'https://news.example/4'])
    expect(out).toContain('2 of the 4 asked for were found, and after them 2 that may not be quite what was asked (the last 2 rows: say each only as what it plainly says).')
    expect(out).not.toMatch(/search no more|first sentence|Only \d/)
  })

  it('stops when the judge repeats its words, or has none, with time left; never searches the same words twice', async () => {
    const s = search([page('x', [row(1, '알파바이오, 베타랩 인수')]), page('y', [row(2, '감마젠, 델타 합병')])])
    const verdicts = ['{"keep":[1],"search":"y"}', '{"keep":[1,2],"search":"y"}']
    const out = await checkedSearch(s, { ask: () => ASK, write: async () => verdicts.shift(), since: 0, now: () => 0 }).run({ query: 'x' }, { task: ASK })
    expect(s.queries).toEqual(['x', 'y'])
    expect(out).toContain('2 of the 4 asked for were found. Lead with the items')
  })

  it('a sure row always ranks before an unsure one, and an unsure row never counts toward the number', async () => {
    const s = search([page('x', [row(1, '바이오 투자 동향'), row(2, '알파, 베타 인수'), row(3, '감마, 델타 합병'), row(4, '엡실론, 제타 인수'), row(5, '이타, 세타 합병')])])
    const out = await checkedSearch(s, { ask: () => '바이오 인수합병 소식 3개', write: async () => '{"keep":[2,3,5],"unsure":[1],"search":""}', since: 0, now: () => 0 }).run({ query: 'x' }, { task: '' })
    expect(urls(out)).toEqual(['https://news.example/2', 'https://news.example/3', 'https://news.example/5'])
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
    const said = await judgedItems('제주 신규 카페 개업 소식 3개', [{ text: 'a' }, { text: 'b' }, { text: 'c' }], async p => { prompt = p; return '{"keep":[1,2],"unsure":[2,3,9]}' }, 1000, 3)
    expect(said).toMatchObject({ keep: [1, 2], unsure: [3] })
    expect(prompt).toContain('it is not kept: put its number in "unsure" instead')
    expect(prompt).not.toContain('keep it.')
    expect(prompt).toContain('"unsure": [<n>]')
  })
})
