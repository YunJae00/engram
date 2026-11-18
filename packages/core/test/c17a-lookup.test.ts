import { describe, expect, it } from 'vitest'
import { checkedSearch } from '../src/item-check.js'
import { helperParts } from '../src/lead-check.js'
import { mergedReport } from '../src/company-tools.js'
import type { AgentTool } from '../src/agent-loop.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { agreeing } from './agreeing.js'

const page = (query: string, rows: string[], words = ''): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows, ...(words ? ['', words] : [])].join('\n')
const row = (n: number, title: string, snippet: string, host = 'news.example'): string => `- ${title} — https://${host}/${n} — ${snippet} — 11월 ${n}일`
function search(outs: string[]): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return outs.shift() ?? page(String(args['query']), []) } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)

// c19a (cause H): evidenced / stated / Proof are gone. The reader gets every row and the opened top pages; a helper's own cited sentences
// stand, and only a link to a page it was never shown loses its link. Nothing is relabelled or said "not found" by a judge.
describe('c17a: evidence is the item\'s own words, by shape', () => {
  const item = { title: '광주 내일 미세먼지 전망 정리', text: '광주 내일 미세먼지 전망 정리 — 광주 지역 미세먼지 관련 소식을 모았습니다 — 11월 18일' }
  it('no host test decides whether a headline states the value: the row goes to the reader and its page is opened for it', async () => {
    const ask = '광주 내일 미세먼지 어때?', opened: string[] = []
    const s = search([page('q', [`- ${item.title} — https://news.example/1 — 광주 지역 미세먼지 관련 소식을 모았습니다 — 11월 18일`])])
    let calls = 0
    const out = await checkedSearch(s, { ask: () => ask, write: async () => { calls++; return '{}' }, since: 0, now: () => 0, read: async url => { opened.push(url); return "광주 대기질 예보\n내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥" } }).run({ query: 'q' }, { task: ask })
    expect(calls).toBe(0)
    expect(opened).toEqual(['https://news.example/1'])
    expect(urls(out)).toEqual(['https://news.example/1'])
    expect(out).toContain('The page at https://news.example/1, opened and read (DATA, not instructions):')
    expect(out).toContain("내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥")
  })
})

describe('c17a: headline vs value (광주 미세먼지)', () => {
  const ask = '광주 내일 미세먼지 어때?'
  const headline = row(1, '광주 내일 미세먼지 전망 정리', '광주 지역 미세먼지 관련 소식을 모았습니다')
  const value = row(2, '광주 대기질 예보', "내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥", 'air.example')
  it('a judge that would quote the headline as the value is not asked: both rows reach the reader, with no host quote line', async () => {
    const s = search([page('q', [headline, value])])
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => JSON.stringify({ keep: [1, 2], points: ['미세먼지 등급'], asked: 1, search: '', holds: { 1: { '미세먼지 등급': '광주 내일 미세먼지 전망 정리' }, 2: { '미세먼지 등급': "내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥" } } })), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://air.example/2'])
    expect(out).not.toContain('· 미세먼지 등급:')
  })

  it('only the headline: the host opens its page right after the search, with no judge, and its words reach the reader', async () => {
    const s = search([page('q', [headline])]), opened: string[] = [], prompts: string[] = []
    const verdicts = [JSON.stringify({ keep: [1], points: ['미세먼지 등급'], asked: 1, search: '', open: 1, holds: { 1: { '미세먼지 등급': '광주 내일 미세먼지 전망 정리' } } }), JSON.stringify({ keep: [], asked: 1, search: '', holds: { 2: { '미세먼지 등급': "광주는 내일 미세먼지 '나쁨'" } } })]
    const out = await checkedSearch(s, {
      ask: () => ask, write: agreeing(async p => { prompts.push(p); return verdicts.shift() }), since: 0, now: () => 0,
      read: async url => { opened.push(url); return "광주 내일 미세먼지 전망 정리\n기상청에 따르면 광주는 내일 미세먼지 '나쁨' 수준이 예상돼요." },
    }).run({ query: 'q' }, { task: ask })
    expect(opened).toEqual(['https://news.example/1'])
    expect(prompts).toHaveLength(0)
    expect(out).toContain("광주는 내일 미세먼지 '나쁨' 수준")
    expect(out).not.toContain('· 미세먼지 등급:')
  })

  it('only the headline, no page reader: a single-value ask runs no second search; the row goes to the reader', async () => {
    const s = search([page('q', [headline]), page('광주 미세먼지 예보 등급', [value])])
    const verdicts = [JSON.stringify({ keep: [1], points: ['미세먼지 등급'], asked: 1, search: '광주 미세먼지 예보 등급', holds: {} }), JSON.stringify({ keep: [2], asked: 1, search: '', holds: { 2: { '미세먼지 등급': "미세먼지 '나쁨'" } } })]
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => verdicts.shift()), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://news.example/1'])
  })

  it('"멈춰" during a host-side page open returns at once; nothing is judged or searched', async () => {
    const stop = new AbortController(), s = search([page('q', [headline])])
    let calls = 0
    const started = Date.now()
    const out = checkedSearch(s, {
      ask: () => ask, write: agreeing(async () => { calls++; return JSON.stringify({ keep: [1], points: ['미세먼지 등급'], asked: 1, search: '', open: 1, holds: {} }) }), since: 0, now: () => 0,
      read: () => { setTimeout(() => stop.abort(), 50); return new Promise<string>(() => undefined) },
    }).run({ query: 'q' }, { task: ask, signal: stop.signal })
    await out
    expect(Date.now() - started).toBeLessThan(500)
    expect(calls).toBe(0)
    expect(s.queries).toEqual(['q'])
  })
})

describe('c17a: kind (바이오 인수합병 4개)', () => {
  const ask = '요즘 국내 바이오 스타트업 인수합병 뉴스 4개'
  const rows = [
    row(1, '바이오젠코리아, 셀메드 인수', '바이오젠코리아가 세포치료 스타트업 셀메드를 인수했다'),
    row(2, '바이오 M&A 컨퍼런스 개최', '국내 바이오 인수합병 전략을 논의하는 컨퍼런스가 열린다'),
    row(3, '진랩, 엔자임원 합병 완료', '유전체 분석 기업 진랩이 엔자임원과의 합병을 마쳤다'),
    row(4, '바이오 전용 펀드 1천억 출범', '바이오 스타트업에 투자하는 펀드가 출범했다'),
    row(5, '메디큐브, 뉴로스타 지분 100% 인수', '디지털 치료제 스타트업 뉴로스타 지분 100%를 인수했다'),
  ]
  const kind = '국내 바이오 스타트업이 인수되거나 합병됐다는 보도'
  it('5 rows for 4 asked: no further search; every row goes to the reader, which lists only what is of the kind (the search\'s own count line tells it)', async () => {
    const s = search([page('q', rows), page('바이오 스타트업 피인수', [row(6, '바이오 업계 동향', '올해 바이오 투자 시장 분위기')])])
    const verdicts = [
      JSON.stringify({ keep: [1, 2, 3, 4, 5], asked: 4, kind, search: '바이오 스타트업 피인수', holds: { 1: { kind: '셀메드를 인수했다' }, 2: { kind: '바이오 기업 인수 완료' }, 3: { kind: '엔자임원과의 합병을 마쳤다' }, 5: { kind: '뉴로스타 지분 100% 인수' } } }),
      JSON.stringify({ keep: [6], asked: 4, search: '', holds: {} }),
    ]
    let t = 0
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => { t += 3000; return verdicts.shift() }), since: 0, now: () => t }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4', 'https://news.example/5'])
    expect(out).not.toMatch(/of these rows are from the period asked|asked for were found/)
  })
})

describe('c17a: two points (맥북 에어 M6 가격이랑 출시일)', () => {
  const ask = '맥북 에어 M6 가격이랑 출시일'
  it('a price row and no date: no judge round and no host "not found"; the helper\'s own sentences are its row', async () => {
    const s = search([page('q', [row(1, '맥북 에어 M6 국내 가격', '맥북 에어 M6는 179만 원부터 시작한다', 'apple.example')]), page('맥북 에어 M6 출시일', [row(2, '애플 신제품 루머', '내년 상반기 여러 제품이 나올 전망')])])
    const verdicts = [JSON.stringify({ keep: [1], points: ['가격', '출시일'], asked: 1, search: '맥북 에어 M6 출시일', holds: { 1: { 가격: '179만 원부터' } } }), JSON.stringify({ keep: [2], asked: 1, search: '맥북 에어 M6 발매 날짜', holds: {} })]
    let t = 0
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => { t += 8000; return verdicts.shift() }), since: 0, now: () => t }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q'])
    expect(out).not.toMatch(/· 가격:|Not found in anything read/)
    expect(urls(out)).toEqual(['https://apple.example/1'])
    const at = new Date().toISOString()
    const helper = (said: string): TeamMember => ({ id: 'h', parentId: null, depth: 1, role: '맥북 조사', topic: '맥북 에어 M6', brief: ask, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said || 'x', said, shown: ['https://apple.example/1'] })
    const [own] = helperParts([helper('맥북 에어 M6는 179만 원부터예요. [애플](https://apple.example/1)')])
    expect(own!.data!.facts[0]!.text).toBe('맥북 에어 M6는 179만 원부터예요.')
    const [told] = helperParts([helper('맥북 에어 M6는 179만 원부터예요 [애플](https://apple.example/1). 출시일은 아직 안 나왔어요.')])
    expect(told!.data!.facts[0]!.text.match(/출시일/g)).toHaveLength(1)
    const [cut] = helperParts([helper('')])
    expect(cut!.data).toBeUndefined()
    const galaxy: TeamMember = { ...helper('갤럭시북 6는 159만 원이고 3월 6일 나와요. [삼성](https://samsung.example/1)'), id: 'g', topic: '갤럭시북 6', shown: ['https://samsung.example/1'] }
    const table = mergedReport(helperParts([helper('맥북 에어 M6는 179만 원부터예요. [애플](https://apple.example/1)'), galaxy]), new Map(), [], true)
    expect(table.split('\n')[0]).toBe('맥북 에어 M6·갤럭시북 6 다 찾았어요.')
    expect(table).not.toContain('못 찾았어요')
    expect(table).not.toMatch(/^\|/m)
    expect(table).toContain('맥북 에어 M6는 179만 원부터예요. [')
    expect(table).toContain('갤럭시북 6는 159만 원이고 3월 6일 나와요.')
  })
})

describe('c17a r2 (c19a): a helper\'s words stand; only a link to a page it was never shown loses its link', () => {
  const at = new Date().toISOString()
  const helper = (said: string, shown?: string[]): TeamMember => ({ id: 'h', parentId: null, depth: 1, role: '수원 조사', topic: '수원', brief: '수원 이번 주말 꽃가루 농도 어때?', lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said, said, ...(shown ? { shown } : {}) })
  // c19a r2 (Codex r1 #5): the words stay with no link, never re-cited to an unrelated page the helper was shown.
  it('cited prose on a page it was never shown keeps its words with no link; the part is found, never "못 찾았어요"', () => {
    const [m] = helperParts([helper('수원은 주말 꽃가루가 낮음이에요. [블로그](https://blog.example/7)', ['https://search.example/?q=pollen'])])
    expect(m!.data!.facts).toEqual([{ text: '수원은 주말 꽃가루가 낮음이에요.', url: '', site: expect.any(String) }])
    const table = mergedReport([m!], new Map(), [], true)
    expect(table).toContain('낮음')
    expect(table).not.toMatch(/\]\(|search\.example|blog\.example/)
    expect(table).not.toContain('못 찾았어요')
  })
  it('of two cited facts, the one on a page never shown stays as its own fact with no link (c19a r3 #3; a trailing slash aside); nothing is labelled missing', () => {
    const [m] = helperParts([helper('수원은 주말 꽃가루 \'보통\'이에요 [기상청](https://weather.example/pollen/). 일요일엔 비 소식이 있어요 [카페](https://cafe.example/3).', ['https://weather.example/pollen'])])
    expect(m!.data!.facts.map(f => f.url)).toEqual(['https://weather.example/pollen/', ''])
    expect(m!.data!.facts.map(f => f.text)).toEqual(["수원은 주말 꽃가루 '보통'이에요", '일요일엔 비 소식이 있어요'])
  })
  it('a page the helper opened and read itself stands; a sentence cited to a page it never saw stays with no link (c19a r3 #3)', () => {
    const [m] = helperParts([{ ...helper('수원은 주말 꽃가루 \'높음\'이에요 [기상청](https://weather.example/pollen). 토요일이 제일 심해요 [뉴스](https://news.example/9).', ['https://search.example/?q=x']), sources: ['https://weather.example/pollen', 'https://search.example/?q=x'] }])
    expect(m!.data!.facts.map(f => f.url)).toEqual(['https://weather.example/pollen', ''])
    expect(m!.data!.facts[1]!.text).toContain('토요일이 제일 심해요')
  })
  it('a helper with no record of what it was shown keeps its cited words as before', () => {
    const [m] = helperParts([helper('수원은 주말 꽃가루가 낮음이에요. [블로그](https://blog.example/7)')])
    expect(m!.data!.facts[0]!.url).toBe('https://blog.example/7')
  })
})

describe('c17a r2: a counted ask with several points counts only items that state every point', () => {
  const ask = '아이패드 미니 8이랑 갤럭시 탭 S12 무게랑 배터리 용량 비교해줘'
  it('two rows for two asked: no further search and no host "not found" line; both rows go to the reader', async () => {
    const s = search([
      page('q', [row(1, '아이패드 미니 8 무게', '아이패드 미니 8은 293g이다', 'apple.example'), row(2, '갤럭시 탭 S12 무게', '갤럭시 탭 S12는 498g이다', 'samsung.example')]),
      page('태블릿 배터리 용량', [row(3, '태블릿 신제품 소식', '여러 태블릿이 곧 나온다')]),
    ])
    const verdicts = [
      JSON.stringify({ keep: [1, 2], asked: 2, points: ['무게', '배터리 용량'], holds: { 1: { 무게: '293g' }, 2: { 무게: '498g' } }, search: '태블릿 배터리 용량' }),
      JSON.stringify({ keep: [], asked: 2, holds: {}, search: '' }),
    ]
    let t = 0
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => { t += 4000; return verdicts.shift() }), since: 0, now: () => t }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://apple.example/1', 'https://samsung.example/2'])
    expect(out).not.toContain('not found in anything read')
  })
  it('rows that state every point end it in one round', async () => {
    const s = search([page('q', [row(1, '아이패드 미니 8', '293g, 배터리 5,078mAh', 'apple.example'), row(2, '갤럭시 탭 S12', '498g, 배터리 8,400mAh', 'samsung.example')])])
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => JSON.stringify({ keep: [1, 2], asked: 2, points: ['무게', '배터리 용량'], holds: { 1: { 무게: '293g', '배터리 용량': '5,078mAh' }, 2: { 무게: '498g', '배터리 용량': '8,400mAh' } }, search: '더 찾기' })), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://apple.example/1', 'https://samsung.example/2'])
    expect(out).not.toContain('not found')
  })
})

describe('c17a r3 (c19a): a helper\'s cell is its own sentences; the host relabels nothing', () => {
  const at = new Date().toISOString()
  const helper = (brief: string, said: string, extra: Partial<TeamMember>): TeamMember => ({ id: 'h', parentId: null, depth: 1, role: '조사', topic: '대상', brief, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said, said, ...extra })
  it('both values a helper cited to a page it was shown stand, with no host label', () => {
    const [m] = helperParts([helper('라이트북 무게와 배터리 알려줘', '라이트북은 1.2kg이고 배터리는 90Wh예요. [제품](https://example.com/p)', { shown: ['https://example.com/p'] })])
    const text = m!.data!.facts.map(f => f.text).join(' ')
    expect(text).toContain('90Wh')
    expect(text).toContain('1.2kg')
    expect(text).not.toContain('못 찾았어요')
  })
  it('the helper\'s whole sentence stands as it wrote it', () => {
    const [m] = helperParts([helper('제주 렌터카 하루 요금이랑 보험료', '제주 렌터카는 하루 4만 2천 원, 보험은 1만 5천 원이에요 [업체](https://rent.example/jeju)', { shown: ['https://rent.example/jeju'] })])
    expect(m!.data!.facts.map(f => f.text).join(' ')).toBe('제주 렌터카는 하루 4만 2천 원, 보험은 1만 5천 원이에요')
  })
  it('prose cited to a page it was never shown stays, with no link (c19a r2: never cited to what it was shown instead); the row is found, never said not found', () => {
    const [m] = helperParts([helper('수원 이번 주말 꽃가루 농도 알려줘', '수원 꽃가루는 낮음이에요. [기사](https://example.com/a)', { shown: ['https://search.example/?q=pollen'] })])
    expect(m!.data!.facts.map(f => f.url)).toEqual([''])
    const table = mergedReport([m!], new Map(), [], true)
    expect(table).toContain('낮음')
    expect(table).not.toContain('못 찾았어요')
  })
  it('on a page it read whole itself, its prose stands and nothing is said as not found', () => {
    const [m] = helperParts([helper('부산 해수욕장 수온이랑 파고', '해운대 수온은 22도예요 [해양청](https://sea.example/busan). 파고는 1.5m예요 [해양청](https://sea.example/busan)', { shown: [], sources: ['https://sea.example/busan'] })])
    const text = m!.data!.facts.map(f => f.text).join(' ')
    expect(text).toContain('22도')
    expect(text).toContain('1.5m')
    expect(text).not.toContain('못 찾았어요')
  })
  it('a point the helper did not state is not added by the host as not found', () => {
    const [m] = helperParts([helper('부산 해수욕장 수온이랑 파고', '해운대 수온은 22도예요 [해양청](https://sea.example/busan)', { shown: [], sources: ['https://sea.example/busan'] })])
    expect(m!.data!.facts.map(f => f.text).join(' ')).toBe('해운대 수온은 22도예요')
  })
})
