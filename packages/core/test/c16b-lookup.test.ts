import { describe, expect, it } from 'vitest'
import { checkedSearch, judgedItems } from '../src/item-check.js'
import { kindChecked, withItems } from '../src/company-tools.js'
import type { AgentTool } from '../src/agent-loop.js'
import { agreeing } from './agreeing.js'

const page = (query: string, rows: string[], words = ''): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows, ...(words ? ['', words] : [])].join('\n')
const row = (n: number, title: string, host = 'news.example', snippet = 'x'): string => `- ${title} — https://${host}/${n} — ${snippet} — 11월 ${n}일`
const told = (n: number, title: string, host = 'news.example'): string => row(n, title, host, `관계자 설명: ${title.split(' ').slice(1).join(' ')}`)
function search(outs: string[]): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return outs.shift() ?? '' } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
const run = (s: AgentTool, ask: string, verdicts: (string | undefined)[], prompts: string[] = [], at = 0): Promise<string> =>
  checkedSearch(s, { ask: () => ask, write: agreeing(async p => { prompts.push(p); return verdicts.shift() }), since: 0, now: () => at }).run({ query: 'q' }, { task: ask })

// c19a (cause H): the item judge no longer holds, proves or drops rows. The reader gets every row and the results page's own words; a
// counted ask with fewer rows than asked searches again (the quick model offers only the words); a single-value ask makes no judge call.
describe('c16b (a): a fit stays a fit', () => {
  const ASK = '요즘 국내 핀테크 인수합병 소식 6건만'
  it('5 rows for 6 asked: one more search on the quick model\'s words; every row of both searches reaches the reader, none dropped', async () => {
    const s = search([
      page('q', [told(1, '페이원, 송금앱 머니톡 인수'), told(2, '핀뱅크, 결제 대행사 합병'), told(3, '토큰랩, 보안 스타트업 인수'), told(4, '카드사, 간편결제 지분 인수'), row(5, '핀테크 업계 전망')]),
      page('핀테크 M&A 계약', [told(6, '대출 플랫폼 렌딩원 피인수'), told(7, '자산관리 앱 웰스온 인수 완료'), told(8, '핀뱅크·결제 대행사 합병 승인', 'other.example')]),
    ])
    const prompts: string[] = []
    const out = await run(s, ASK, ['{"keep":[1,2,3,4],"asked":6,"search":"핀테크 M&A 계약","kind":"핀테크 기업이 인수하거나 합병했다는 보도","holds":{"1":{"kind":"송금앱 머니톡 인수"},"2":{"kind":"결제 대행사 합병"},"3":{"kind":"보안 스타트업 인수"},"4":{"kind":"간편결제 지분 인수"}}}', '{"keep":[2,3,5,6,7],"listing":[1],"same":[[2,7]],"asked":6,"search":"","holds":{"5":{"kind":"렌딩원 피인수"},"6":{"kind":"웰스온 인수 완료"},"7":{"kind":"합병 승인"}}}'], prompts)
    expect(s.queries).toEqual(['q', '핀테크 M&A 계약'])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('unlike every search already run ("q")')
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4', 'https://news.example/5', 'https://news.example/6', 'https://news.example/7', 'https://other.example/8'])
    expect(out).not.toMatch(/of these rows are from the period asked/)
  })

  it('a first-hand row and a second-hand one for the same event both reach the reader; which to cite is its call', async () => {
    const ask = '하늘시 새 도서관 개관 소식 3건'
    const s = search([
      page('q', [row(1, '하늘시 별숲도서관 개관했대요', 'blog.example'), row(2, '하늘시 푸른도서관 개관')]),
      page('하늘시 도서관 개관 공식', [row(3, '하늘시청: 별숲도서관 개관 안내', 'city.example'), row(4, '하늘시 바람도서관 문 열어')]),
    ])
    const out = await run(s, ask, ['{"keep":[1,2],"asked":3,"search":"하늘시 도서관 개관 공식"}', '{"keep":[3,4],"same":[[1,3]],"secondhand":[1],"asked":3,"search":""}'])
    expect(urls(out)).toEqual(['https://blog.example/1', 'https://news.example/2', 'https://city.example/3', 'https://news.example/4'])
  })

  it('a counted list with enough rows: no judgment at all, and every row is shown', async () => {
    const ask = '이번 주 광주 신규 카페 개업 소식 2개'
    const s = search([page('q', [row(1, '광주 동명동 카페 개업'), row(2, '광주 카페 거리 통계'), row(3, '광주 첨단 베이커리 카페 오픈')])])
    const prompts: string[] = []
    const out = await run(s, ask, ['판단이 어려워요', '{"keep":[1,3],"unsure":[2],"asked":2}'], prompts)
    expect(prompts).toHaveLength(0)
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3'])
    expect(out).not.toMatch(/They hold the|of these rows are from the period asked/)
  })

  it('"멈춰" during round 2 halts in < 500 ms and nothing further runs', async () => {
    const ask = '요즘 국내 핀테크 인수합병 소식 6건만', stop = new AbortController()
    const s = search([page('q', [row(1, '페이원 인수')]), page('w', [row(2, '핀뱅크 합병')]), page('z', [row(3, 'x')])])
    let calls = 0
    const write = agreeing(async (): Promise<string | undefined> => {
      if (++calls === 1) return '{"keep":[1],"asked":6,"search":"w"}'
      setTimeout(() => stop.abort(), 50)
      return new Promise<string | undefined>(() => undefined)
    })
    const started = Date.now()
    const out = await checkedSearch(s, { ask: () => ask, write, since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask, signal: stop.signal })
    expect(Date.now() - started).toBeLessThan(500)
    expect(s.queries).toEqual(['q', 'w'])
    expect(calls).toBe(2)
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2'])
  })
})

describe('c16b (b): a single-value ask is answered from a row that states it', () => {
  const ASK = '비트코인 지금 시세 알려줘'
  const news = [row(1, '비트코인 ETF 자금 유입 이어져'), row(2, '가상자산 거래소 규제 논의', 'quote.example'), row(3, '비트코인 채굴 업계 동향'), row(4, '코인 시장 투자심리 회복')]
  it('four rows about it, none holds the price: no judge round and no extra search; every row goes to the reader, with no host claim about which states it', async () => {
    const s = search([page('q', news), page('비트코인 실시간 시세', ['- 비트코인 현재가 — https://coinquote.example/5 — 현재가 1억 3,520만 원 — 11월 5일'])])
    const prompts: string[] = []
    const out = await run(s, ASK, ['{"keep":[1,2,3,4],"holds":{},"points":["시세"],"asked":1,"search":"비트코인 실시간 시세","open":2}', '{"keep":[5],"holds":{"5":{"시세":"현재가 1억 3,520만 원"}},"asked":1,"search":""}'], prompts)
    expect(prompts).toHaveLength(0)
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://quote.example/2', 'https://news.example/3', 'https://news.example/4'])
    expect(out).not.toContain('What was asked, each with the words that state it')
  })

  it('with no round left: the rows go to the model as they are, with no host verdict on them', async () => {
    const s = search([page('q', news)])
    const out = await run(s, ASK, ['{"keep":[1,2,3,4],"holds":{},"asked":null,"search":"비트코인 실시간 시세","open":2}'], [], 20_000)
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toHaveLength(4)
    expect(out).not.toMatch(/none of them states what was asked itself|the results do not say/)
  })

  it('a no-number ask whose answer is in a row: that row leads and no extra round runs', async () => {
    const ask = '광화문 교보문고 오늘 몇 시까지 해?'
    const s = search([page('q', [row(1, '교보문고 광화문점 리뉴얼 소식'), row(2, '교보문고 북콘서트 일정'), '- 교보문고 광화문점 — https://kyobo.example/3 — 영업시간 09:30~22:00 — 11월 3일'])])
    const prompts: string[] = []
    const out = await run(s, ask, ['{"keep":[1,2,3],"holds":{"3":{"영업 종료 시각":"영업시간 09:30~22:00"}},"points":["영업 종료 시각"],"asked":null,"search":""}'], prompts)
    expect(prompts).toHaveLength(0)
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://kyobo.example/3'])
  })

  it('the results page\'s own words (a weather box) hold it: no extra round, and those words reach the model', async () => {
    const ask = '오늘 대전 기온 몇 도야?'
    const s = search([page('q', [row(1, '대전 첫 한파주의보'), row(2, '충청권 아침 영하권')], '대전 유성구 현재 3° 맑음 최저 -2° 최고 9°')])
    const prompts: string[] = []
    const out = await run(s, ask, ['{"keep":[1,2],"holds":{"3":{"기온":"현재 3° 맑음"}},"points":["기온"],"asked":1,"search":""}'], prompts)
    expect(prompts).toHaveLength(0)
    expect(out).not.toContain('· 기온:')
    expect(out).toContain('대전 유성구 현재 3° 맑음')
  })

  it('judgedItems no longer reads holds or open (only rows and search words); a single-value ask makes no judge call', async () => {
    const items = [{ text: 'a 1원' }, { text: 'b 22원' }]
    const v = await judgedItems('x', items, agreeing(async () => '{"keep":[1,2],"holds":{"1":{"p":"99원"},"2":{"p":"22원"},"9":{"p":"x"}},"points":["p"],"open":1}'), 1000, { tried: [] })
    expect(v?.keep).toEqual([1, 2])
    for (const gone of ['holds', 'evidence', 'open', 'points']) expect(v).not.toHaveProperty(gone)
    expect(await judgedItems('x', items, async () => '{"keep":[1],"open":7}', 1000, { tried: [] })).not.toHaveProperty('holds')
    const s = search([page('q', [row(1, '스터디카페 요금')])])
    const prompts: string[] = []
    await run(s, '판교 스터디카페 하루 요금 얼마야', ['{"keep":[1],"asked":null,"search":"w"}'], prompts)
    expect(prompts).toHaveLength(0)
  })

  it('team path: no judge reorders facts by what it says they state; both stay in their order', async () => {
    const facts = [{ text: '제주 감귤 축제 준비 한창', url: 'https://a.example/1', site: 'a' }, { text: '제주 감귤 축제 12월 6일 개막', url: 'https://b.example/2', site: 'b' }]
    const out = await kindChecked({ facts }, '제주 감귤 축제 언제 열려?', agreeing(async () => '{"keep":[1,2],"holds":{"2":{"개막일":"12월 6일 개막"}},"points":["개막일"]}'), 1000)
    expect(out!.facts.map(f => f.url)).toEqual(['https://a.example/1', 'https://b.example/2'])
  })
})

describe('c16b r2: a later search whose page states the value in its own words, with no rows', () => {
  it('reviewer repro: a single-value ask makes no second search; the first page\'s rows reach the model, with no host instruction about page words', async () => {
    const s = search([page('q', [row(1, '코인 뉴스')]), page('w', [], '비트코인 현재가 1억 3천만 원')])
    const out = await run(s, '비트코인 지금 시세 알려줘', ['{"keep":[1],"asked":1,"holds":[],"search":"w"}', undefined])
    expect(s.queries).toEqual(['q'])
    expect(out).toContain('https://news.example/1')
    expect(out).not.toContain("When a results page's own words below state it")
  })

  it('new wording: no judge round, one search; the rows reach the model as they are', async () => {
    const s = search([page('q', [row(1, '엔화 약세 지속 전망'), row(2, '여행 수요 일본 쏠림')]), page('엔 원 환율 실시간', [], '100엔 = 912.40원 전일 대비 +3.1'), page('z', [row(9, 'x')])])
    const prompts: string[] = []
    const out = await run(s, '지금 엔화 환율 얼마예요', ['{"keep":[1,2],"asked":1,"holds":[],"search":"엔 원 환율 실시간"}', '{"keep":[],"holds":{"3":{"환율":"100엔 = 912.40원"}},"asked":1,"search":""}'], prompts)
    expect(prompts).toHaveLength(0)
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2'])
  })

  it('a first page with no rows: its own words are carried once, with no judge call', async () => {
    const s = search([page('q', [], '속초 내일 오전 비 강수확률 70%')])
    const prompts: string[] = []
    const out = await run(s, '속초 내일 비 와?', ['{"keep":[],"holds":{"1":{"비":"오전 비 강수확률 70%"}},"points":["비 여부"],"asked":null,"search":""}'], prompts)
    expect(prompts).toHaveLength(0)
    expect(out.match(/속초 내일 오전 비/g)).toHaveLength(1)
  })

  it('a counted list keeps the results page\'s own words: no row or prose is left out by a judge', async () => {
    const s = search([page('q', [row(1, '가 행사'), row(2, '나 행사')], '다 행사 라 행사')])
    const out = await run(s, '이번 주 행사 2개', ['{"keep":[1,2],"asked":2,"kind":"이번 주 행사","holds":{"1":{"kind":"가 행사"},"2":{"kind":"나 행사"}},"search":""}'])
    expect(out).toContain('다 행사')
  })
})

describe('c16b r3 (c19a): page words reach the reader of a counted list too', () => {
  it('time spent and short: the one row is listed, the count is said plainly as data, and the page prose reaches the reader', async () => {
    const s = search([page('q', [told(3, '대전 북토크 하나', 'books.example')], '대전 북토크 둘 12월 4일 저녁')])
    const out = await run(s, '대전 북토크 2개 알려줘', ['{"keep":[1],"kind":"대전 북토크","holds":{"1":{"kind":"북토크 하나"},"2":{"kind":"북토크 둘"}},"asked":2,"search":""}'], [], 30_000)
    expect(urls(out)).toEqual(['https://books.example/3'])
    expect(out).toContain('1 of these rows are from the period asked, for the 2 asked')
    expect(out).toContain('대전 북토크 둘')
  })
})

describe('c16b (c): c15a r3 #1, identical fact text', () => {
  it('the official page replaces the blog (reviewer\'s 별빛 도서관 repro)', async () => {
    const old = { text: '별빛 도서관은 3월 2일 개관해요', url: 'https://blog.example/old', site: '블로그' }
    const fresh = { text: old.text, url: 'https://city.example/official', site: '구청' }
    const more = await kindChecked({ facts: [fresh] }, '별빛 도서관 개관', async () => JSON.stringify({ keep: [1, 2], same: [[1, 2]], secondhand: [1] }), 1000, [old])
    expect(withItems({ facts: [old] }, more, true).facts.map(f => f.url)).toEqual(['https://city.example/official'])
  })
})
