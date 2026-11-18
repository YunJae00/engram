import { describe, expect, it } from 'vitest'
import { checkedSearch, judgedItems } from '../src/item-check.js'
import { kindChecked } from '../src/company-tools.js'
import type { AgentTool } from '../src/agent-loop.js'

const page = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const row = (n: number, title: string, host = 'news.example'): string => `- ${title} — https://${host}/${n} — x — 11월 ${n}일`
function search(outs: string[]): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return outs.shift() ?? '' } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
const ASK = '요즘 국내 바이오 기업 인수 소식 4곳만'

describe('c15a: a counted lookup shows only sure items and asks for other words while time is left', () => {
  it('2 sure + 2 unsure rows for 4 asked: no further search and no judge call; all 4 rows go to the reader', async () => {
    const s = search([
      page('바이오 기업 인수', [row(1, '셀젠, 진단기업 메디랩 인수'), row(2, '바이오원, 항체 벤처 합병'), row(3, '바이오 업계 M&A 활발'), row(4, '제약사 인수 검토설')]),
      page('제약 바이오 지분 인수 계약', [row(5, '한올팜, 세포치료 기업 지분 60% 인수'), row(6, '지엔티, CDMO 업체 인수 완료')]),
    ])
    const prompts: string[] = []
    const verdicts = ['{"keep":[1,2],"unsure":[3,4],"asked":4,"search":""}', '{"keep":[1,2],"unsure":[3,4],"asked":4,"search":"제약 바이오 지분 인수 계약"}', '{"keep":[1,2,5,6],"unsure":[3,4],"asked":4,"search":""}']
    const out = await checkedSearch(s, { ask: () => ASK, write: async p => { prompts.push(p); return verdicts.shift() }, since: 0, now: () => 0 }).run({ query: '바이오 기업 인수' }, { task: ASK })
    expect(s.queries).toEqual(['바이오 기업 인수'])
    expect(prompts).toEqual([])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4'])
    expect(out).not.toMatch(/of these rows are from the period asked/)
  })

  it('4 rows for 4 asked: no shortfall line, the unsure rows kept', async () => {
    const s = search([page('바이오 기업 인수', [row(1, '셀젠, 진단기업 메디랩 인수'), row(2, '바이오원, 항체 벤처 합병'), row(3, '바이오 업계 M&A 활발'), row(4, '제약사 인수 검토설')])])
    const out = await checkedSearch(s, { ask: () => ASK, write: async () => '{"keep":[1,2],"unsure":[3,4],"asked":4,"search":""}', since: 0, now: () => 0 }).run({ query: '바이오 기업 인수' }, { task: ASK })
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4'])
    expect(out).not.toMatch(/of these rows are from the period asked|may not be quite/)
  })

  it('more rows than asked ("책 2권", "맛집 5곳"): every row is shown with no count line; judgedItems still reads "asked" by meaning', async () => {
    for (const [ask, n] of [['올겨울 읽을 만한 경제 책 2권 추천', 2], ['성수동 브런치 맛집 5곳 알려줘', 5]] as const) {
      const rows = Array.from({ length: n + 1 }, (_, i) => row(i + 1, `항목 ${i + 1}`))
      const keep = Array.from({ length: n }, (_, i) => i + 2)
      const out = await checkedSearch(search([page('q', rows)]), { ask: () => ask, write: async () => JSON.stringify({ keep, unsure: [1], asked: n, search: '' }), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
      expect(urls(out), ask).toHaveLength(n + 1)
      expect(out, ask).not.toMatch(/of these rows are from the period asked/)
    }
    const items = [{ text: 'a' }, { text: 'b' }]
    expect((await judgedItems('x', items, async () => '{"keep":[1],"asked":3}', 1000, { tried: [] }))?.asked).toBe(3)
    expect((await judgedItems('x', items, async () => '{"keep":[1],"asked":null}', 1000, { tried: [] }))?.asked).toBeNull()
    expect((await judgedItems('x', items, async () => '{"keep":[1]}', 1000, { tried: [] }))).not.toHaveProperty('asked')
  })

  it('second-hand: the lookup keeps the search order (the reader picks); a teammate\'s facts are still ranked first-hand first by kindChecked', async () => {
    const rows = [row(1, '하늘폰 X 출시일 정리 - 위키', 'wiki.example'), row(2, '하늘전자, 하늘폰 X 12월 5일 출시', 'news.example')]
    const out = await checkedSearch(search([page('하늘폰 X 출시일', rows)]), { ask: () => '하늘폰 X 출시일 알려줘', write: async () => '{"keep":[1,2],"secondhand":[1],"asked":null}', since: 0, now: () => 0 }).run({ query: '하늘폰 X 출시일' }, { task: '' })
    expect(urls(out)).toEqual(['https://wiki.example/1', 'https://news.example/2'])
    const data = await kindChecked({ facts: [{ text: '하늘폰 X는 12월 5일 출시 (카페 글)', url: 'https://cafe.example/9', site: '카페' }, { text: '하늘전자, 하늘폰 X 12월 5일 출시', url: 'https://news.example/2', site: '뉴스' }] }, '하늘폰 X 출시일', async () => '{"keep":[1,2],"secondhand":[1]}', 1000)
    expect(data?.facts.map(f => f.url)).toEqual(['https://news.example/2', 'https://cafe.example/9'])
  })

  it('a later round: a first-hand fact the judge groups with a second-hand one in other words is added beside it, first-hand first; nothing is dropped (c19a r3 #1)', async () => {
    const { withItems } = await import('../src/company-tools.js')
    const blog = { text: '블로그: 별빛 도서관 개관은 3월 2일이래요', url: 'https://blog.example/7', site: '블로그' }
    const city = { text: '별빛구청, 별빛 도서관 3월 2일 개관', url: 'https://city.example/news/3', site: '구청' }
    const other = { text: '달빛 도서관 리모델링 4월 재개관', url: 'https://city.example/news/4', site: '구청' }
    const out = await kindChecked({ facts: [city, other] }, '구립 도서관 개관 소식', async () => '{"keep":[1,2,3],"same":[[1,2]],"secondhand":[1]}', 1000, [blog])
    expect(out?.facts.map(f => f.url)).toEqual([city.url, other.url])
    const merged = withItems({ facts: [blog] }, out, true)
    expect(merged.facts.map(f => f.url)).toEqual([blog.url, city.url, other.url])
    expect(merged.facts.some(f => 'instead' in f)).toBe(false)
    const back = await kindChecked({ facts: [blog] }, '구립 도서관 개관 소식', async () => '{"keep":[1,2],"same":[[1,2]],"secondhand":[2]}', 1000, [city])
    expect(back?.facts.map(f => f.url)).toEqual([blog.url])
  })

  it('"멈춰" during the judge retry halts at once; no further search starts', async () => {
    const stop = new AbortController()
    const s = search([page('q', [row(1, '셀젠, 메디랩 인수')]), page('more', [row(2, '바이오원 합병')])])
    let calls = 0
    const write = async (): Promise<string | undefined> => {
      calls++
      if (calls === 1) return '{"keep":[1],"asked":4,"search":""}'
      setTimeout(() => stop.abort(), 50)
      return new Promise<string | undefined>(() => undefined)
    }
    const started = Date.now()
    const out = await checkedSearch(s, { ask: () => ASK, write, since: 0, now: () => 0 }).run({ query: 'q' }, { task: ASK, signal: stop.signal })
    expect(Date.now() - started).toBeLessThan(500)
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://news.example/1'])
  })

  it('a helper\'s search reads its own deadline (due), and the judge gets what is left of it', async () => {
    const given: number[] = []
    await checkedSearch(search([page('q', [row(1, 'a'), row(2, 'b')])]), { ask: () => 'x 뉴스 3개', write: async (_p, ms) => { given.push(ms); return '{"keep":[1,2],"asked":null}' }, due: () => 9_000, now: () => 1_000 }).run({ query: 'q' }, { task: '' })
    expect(given[0]).toBe(8_000)
  })
})
