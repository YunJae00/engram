import { describe, expect, it } from 'vitest'
import { checkedSearch } from '../src/item-check.js'
import type { AgentTool } from '../src/agent-loop.js'

// c15a round 2 (Codex r1): a same-event group led by its first row (a café post before the official report), and the words retry that
// needed a held row (a first search of only off-kind rows ended the loop). Wordings are in no harness row.
const page = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const row = (n: number, title: string, host = 'news.example'): string => `- ${title} — https://${host}/${n} — x — 11월 ${n}일`
function search(outs: string[]): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return outs.shift() ?? '' } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)

describe('c15a r2', () => {
  it('a same-event group keeps its first-hand row whatever the order: the blog row listed first goes, the maker\'s page stays', async () => {
    const ask = '별빛제과 신제품 출시일 하나만'
    const rows = [row(1, '별빛제과 신제품 1월 출시래요 (블로그)', 'blog.example'), row(2, '별빛제과, 신제품 1월 10일 출시 발표', 'maker.example')]
    const out = await checkedSearch(search([page('q', rows)]), { ask: () => ask, write: async () => JSON.stringify({ keep: [1, 2], same: [[1, 2]], secondhand: [1], asked: 1, search: '' }), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    expect(urls(out)).toEqual(['https://maker.example/2'])
  })

  it('a group with no first-hand row still leads with a sure row before an unsure one', async () => {
    const ask = '광주 수제맥주 펍 개업 소식 1건'
    const rows = [row(1, '광주 펍 개업?'), row(2, '광주 동명동 수제맥주 펍 개업')]
    const out = await checkedSearch(search([page('q', rows)]), { ask: () => ask, write: async () => JSON.stringify({ keep: [2], unsure: [1], same: [[1, 2]], asked: 1, search: '' }), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    expect(urls(out)).toEqual(['https://news.example/2'])
  })

  it('a first search of only off-kind rows: the judge is still asked for other words (with no rows), and the new search runs', async () => {
    const ask = '대전 반도체 공장 착공 소식 2건'
    const s = search([page('대전 반도체', [row(1, '대전 반도체 박람회 개막')]), page('대전 반도체 공장 착공식', [row(2, '대전 A사 반도체 공장 착공'), row(3, '대전 B사 반도체 2공장 첫 삽')])])
    const prompts: string[] = []
    const verdicts = ['{"keep":[],"unsure":[],"asked":2,"search":""}', '{"keep":[],"asked":2,"search":"대전 반도체 공장 착공식"}', '{"keep":[1,2],"asked":2,"search":""}']
    const out = await checkedSearch(s, { ask: () => ask, write: async p => { prompts.push(p); return verdicts.shift() }, since: 0, now: () => 0 }).run({ query: '대전 반도체' }, { task: ask })
    expect(s.queries).toEqual(['대전 반도체', '대전 반도체 공장 착공식'])
    expect(prompts[1]).toContain('Items: []')
    expect(prompts[1]).toContain('unlike every search already run ("대전 반도체")')
    expect(urls(out)).toEqual(['https://news.example/2', 'https://news.example/3'])
  })

  it('a first search with no rows at all is judged too, so a counted ask still looks again', async () => {
    const ask = '인천 전기버스 도입 뉴스 3개'
    const s = search([page('인천 버스', []), page('인천 전기버스 도입', [row(1, '인천시 전기버스 100대 도입'), row(2, '인천 시내버스 전기차 전환'), row(3, '인천 공항버스 전기버스 투입')])])
    const verdicts = ['{"keep":[],"asked":3,"search":"인천 전기버스 도입"}', '{"keep":[1,2,3],"asked":3,"search":""}']
    const out = await checkedSearch(s, { ask: () => ask, write: async () => verdicts.shift(), since: 0, now: () => 0 }).run({ query: '인천 버스' }, { task: ask })
    expect(s.queries).toEqual(['인천 버스', '인천 전기버스 도입'])
    expect(urls(out)).toHaveLength(3)
  })
})
