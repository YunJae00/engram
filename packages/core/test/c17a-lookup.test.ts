import { describe, expect, it } from 'vitest'
import { checkedSearch, evidenced, type Proof } from '../src/item-check.js'
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

describe('c17a: evidence is the item\'s own words, by shape', () => {
  const item = { title: '광주 내일 미세먼지 전망 정리', text: '광주 내일 미세먼지 전망 정리 — 광주 지역 미세먼지 관련 소식을 모았습니다 — 11월 18일' }
  it('a value is never evidenced by the title alone, nor by the ask\'s own words, nor by words not in the item', () => {
    const ask = '광주 내일 미세먼지 어때?'
    expect(evidenced('광주 내일 미세먼지 전망 정리', item, ask, true)).toBe(false)
    expect(evidenced('광주 내일 미세먼지', { text: '광주 내일 미세먼지 나쁨' }, ask, true)).toBe(false)
    expect(evidenced('미세먼지 나쁨', item, ask, true)).toBe(false)
    expect(evidenced("내일 광주 미세먼지 '나쁨'", { title: '광주 대기질 예보', text: "광주 대기질 예보 — 내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥" }, ask, true)).toBe(true)
    expect(evidenced('초미세먼지  38㎍/㎥', { text: '초미세먼지 38㎍/㎥ 예상' }, ask, true)).toBe(true)
    expect(evidenced('바이오젠코리아, 셀메드 인수', { title: '바이오젠코리아, 셀메드 인수', text: '바이오젠코리아, 셀메드 인수' }, '바이오 스타트업 인수합병 뉴스 4개', false)).toBe(true)
    expect(evidenced('바이오젠코리아, 셀메드 인수', { title: '바이오젠코리아, 셀메드 인수', text: '바이오젠코리아, 셀메드 인수 — x' }, '바이오 스타트업 인수합병 뉴스 4개', false)).toBe(false)
  })
})

describe('c17a: headline vs value (광주 미세먼지)', () => {
  const ask = '광주 내일 미세먼지 어때?'
  const headline = row(1, '광주 내일 미세먼지 전망 정리', '광주 지역 미세먼지 관련 소식을 모았습니다')
  const value = row(2, '광주 대기질 예보', "내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥", 'air.example')
  it('a judge that quotes the headline as the value: only the row whose own words state it holds, and it alone is shown', async () => {
    const s = search([page('q', [headline, value])])
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => JSON.stringify({ keep: [1, 2], points: ['미세먼지 등급'], asked: 1, search: '', holds: { 1: { '미세먼지 등급': '광주 내일 미세먼지 전망 정리' }, 2: { '미세먼지 등급': "내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥" } } })), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://air.example/2'])
    expect(out).toContain(`· 미세먼지 등급: "내일 광주 미세먼지 '나쁨', 초미세먼지 38㎍/㎥" (https://air.example/2)`)
  })

  it('only the headline, quoted as the value: with time left the judge\'s page is opened by the host and its words prove it', async () => {
    const s = search([page('q', [headline])]), opened: string[] = [], prompts: string[] = []
    const verdicts = [JSON.stringify({ keep: [1], points: ['미세먼지 등급'], asked: 1, search: '', open: 1, holds: { 1: { '미세먼지 등급': '광주 내일 미세먼지 전망 정리' } } }), JSON.stringify({ keep: [], asked: 1, search: '', holds: { 2: { '미세먼지 등급': "광주는 내일 미세먼지 '나쁨'" } } })]
    let found: { proof: Proof[]; missing: string[] } | undefined
    const out = await checkedSearch(s, {
      ask: () => ask, write: agreeing(async p => { prompts.push(p); return verdicts.shift() }), since: 0, now: () => 0,
      read: async url => { opened.push(url); return "광주 내일 미세먼지 전망 정리\n기상청에 따르면 광주는 내일 미세먼지 '나쁨' 수준이 예상돼요." },
      proved: (proof, missing) => { found = { proof, missing } },
    }).run({ query: 'q' }, { task: ask })
    expect(opened).toEqual(['https://news.example/1'])
    expect(prompts[1]).toContain('What each answer must state ("points"): ["미세먼지 등급"]')
    expect(prompts[1]).toContain("광주는 내일 미세먼지 '나쁨' 수준")
    expect(out).toContain(`· 미세먼지 등급: "광주는 내일 미세먼지 '나쁨'" (https://news.example/1)`)
    expect(found).toEqual({ proof: [{ point: '미세먼지 등급', quote: "광주는 내일 미세먼지 '나쁨'", url: 'https://news.example/1' }], missing: [] })
  })

  it('only the headline, no page reader: a second search round runs on the judge\'s words while time is left', async () => {
    const s = search([page('q', [headline]), page('광주 미세먼지 예보 등급', [value])])
    const verdicts = [JSON.stringify({ keep: [1], points: ['미세먼지 등급'], asked: 1, search: '광주 미세먼지 예보 등급', holds: {} }), JSON.stringify({ keep: [2], asked: 1, search: '', holds: { 2: { '미세먼지 등급': "미세먼지 '나쁨'" } } })]
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => verdicts.shift()), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q', '광주 미세먼지 예보 등급'])
    expect(urls(out)).toEqual(['https://air.example/2'])
  })

  it('"멈춰" during a host-side page open returns at once; nothing more is judged or searched', async () => {
    const stop = new AbortController(), s = search([page('q', [headline])])
    let calls = 0
    const started = Date.now()
    const out = checkedSearch(s, {
      ask: () => ask, write: agreeing(async () => { calls++; return JSON.stringify({ keep: [1], points: ['미세먼지 등급'], asked: 1, search: '', open: 1, holds: {} }) }), since: 0, now: () => 0,
      read: () => { setTimeout(() => stop.abort(), 50); return new Promise<string>(() => undefined) },
    }).run({ query: 'q' }, { task: ask, signal: stop.signal })
    await out
    expect(Date.now() - started).toBeLessThan(500)
    expect(calls).toBe(1)
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
  it('keep counts 5 but only 3 are evidenced acquisitions: the loop goes on while time is left; at the due 3 are listed, never a padded 4th', async () => {
    const s = search([page('q', rows), page('바이오 스타트업 피인수', [row(6, '바이오 업계 동향', '올해 바이오 투자 시장 분위기')])])
    const verdicts = [
      JSON.stringify({ keep: [1, 2, 3, 4, 5], asked: 4, kind, search: '바이오 스타트업 피인수', holds: { 1: { kind: '셀메드를 인수했다' }, 2: { kind: '바이오 기업 인수 완료' }, 3: { kind: '엔자임원과의 합병을 마쳤다' }, 5: { kind: '뉴로스타 지분 100% 인수' } } }),
      JSON.stringify({ keep: [6], asked: 4, search: '', holds: {} }),
    ]
    let t = 0
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => { t += 3000; return verdicts.shift() }), since: 0, now: () => t }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q', '바이오 스타트업 피인수', kind])
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/3', 'https://news.example/5'])
    expect(out).toContain('3 of the 4 asked for were found')
    expect(out).not.toContain('컨퍼런스')
    expect(out).not.toContain('펀드')
  })
})

describe('c17a: two points (맥북 에어 M6 가격이랑 출시일)', () => {
  const ask = '맥북 에어 M6 가격이랑 출시일'
  it('a price quote and no date: a date search runs; at the due the date is said not found, and the helper\'s row says so', async () => {
    const s = search([page('q', [row(1, '맥북 에어 M6 국내 가격', '맥북 에어 M6는 179만 원부터 시작한다', 'apple.example')]), page('맥북 에어 M6 출시일', [row(2, '애플 신제품 루머', '내년 상반기 여러 제품이 나올 전망')])])
    const verdicts = [JSON.stringify({ keep: [1], points: ['가격', '출시일'], asked: 1, search: '맥북 에어 M6 출시일', holds: { 1: { 가격: '179만 원부터' } } }), JSON.stringify({ keep: [2], asked: 1, search: '맥북 에어 M6 발매 날짜', holds: {} })]
    let t = 0, found: { proof: Proof[]; missing: string[] } | undefined
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => { t += 8000; return verdicts.shift() }), since: 0, now: () => t, proved: (proof, missing) => { found = { proof, missing } } }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q', '맥북 에어 M6 출시일'])
    expect(out).toContain('· 가격: "179만 원부터" (https://apple.example/1)')
    expect(out).toContain('Not found in anything read: 출시일')
    expect(urls(out)).toEqual(['https://apple.example/1'])
    expect(found!.missing).toEqual(['출시일'])
    const at = new Date().toISOString()
    const helper = (said: string): TeamMember => ({ id: 'h', parentId: null, depth: 1, role: '맥북 조사', topic: '맥북 에어 M6', brief: ask, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said || 'x', said, proof: found!.proof, missing: found!.missing })
    const [own] = helperParts([helper('맥북 에어 M6는 179만 원부터예요. [애플](https://apple.example/1)')])
    expect(own!.data!.facts[0]!.text).toBe('가격: 179만 원부터. 출시일은 못 찾았어요.')
    const [told] = helperParts([helper('맥북 에어 M6는 179만 원부터예요 [애플](https://apple.example/1). 출시일은 아직 안 나왔어요.')])
    expect(told!.data!.facts[0]!.text.match(/출시일/g)).toHaveLength(1)
    const [cut] = helperParts([helper('')])
    expect(cut!.data!.facts).toEqual([{ text: '가격: 179만 원부터. 출시일은 못 찾았어요.', url: 'https://apple.example/1', site: expect.any(String) }])
    const galaxy: TeamMember = { ...helper('갤럭시북 6는 159만 원이고 3월 6일 나와요. [삼성](https://samsung.example/1)'), id: 'g', topic: '갤럭시북 6', proof: [{ point: '가격', quote: '159만 원', url: 'https://samsung.example/1' }, { point: '출시일', quote: '3월 6일', url: 'https://samsung.example/1' }], missing: [] }
    const table = mergedReport(helperParts([helper('맥북 에어 M6는 179만 원부터예요. [애플](https://apple.example/1)'), galaxy]), new Map(), [], true)
    expect(table.split('\n')[0]).toBe('갤럭시북 6는 다 찾았어요.')
    expect(table.match(/출시일은 못 찾았어요/g)).toHaveLength(1)
    expect(table).not.toMatch(/^\|/m)
    expect(table).toMatch(/^맥북 에어 M6 가격은 [^\n]*출시일은 못 찾았어요\. \[[^\]]+\]\(https:\/\/apple\.example\/1\)$/m)
  })
})

describe('c17a r2: a helper\'s words stand only on a page with a verified quote', () => {
  const at = new Date().toISOString()
  const helper = (said: string, proof: Proof[], missing: string[]): TeamMember => ({ id: 'h', parentId: null, depth: 1, role: '수원 조사', topic: '수원', brief: '수원 이번 주말 꽃가루 농도 어때?', lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said, said, proof, missing })
  it('cited prose on a page that verified nothing is no cell; the row has no fact and its point is said not found', () => {
    const [m] = helperParts([helper('수원은 주말 꽃가루가 낮음이에요. [블로그](https://blog.example/7)', [], ['꽃가루 농도'])])
    expect(m!.data).toBeUndefined()
    const table = mergedReport([m!], new Map(), [], true)
    expect(table).not.toContain('낮음')
    expect(table.split('\n')[0]).toContain('못 찾았어요')
  })
  it('of two cited facts, only the one on the verified page stays (a trailing slash aside), and the missing point is labelled', () => {
    const [m] = helperParts([helper('수원은 주말 꽃가루 \'보통\'이에요 [기상청](https://weather.example/pollen/). 일요일엔 비 소식이 있어요 [카페](https://cafe.example/3).', [{ point: '꽃가루 농도', quote: "꽃가루 '보통'", url: 'https://weather.example/pollen' }], ['강수'])])
    expect(m!.data!.facts.map(f => f.url)).toEqual(['https://weather.example/pollen'])
    expect(m!.data!.facts[0]!.text).toBe("꽃가루 농도: 꽃가루 '보통'. 강수는 못 찾았어요.")
  })
  it('a page the helper opened and read itself is first-hand: its words on it stand; a results row it only saw does not', () => {
    const [m] = helperParts([{ ...helper('수원은 주말 꽃가루 \'높음\'이에요 [기상청](https://weather.example/pollen). 토요일이 제일 심해요 [뉴스](https://news.example/9).', [], ['꽃가루 농도']), sources: ['https://weather.example/pollen', 'https://search.example/?q=x'] }])
    expect(m!.data!.facts.map(f => f.url)).toEqual(['https://weather.example/pollen'])
  })
  it('a helper whose lookup judged no points keeps its cited words as before', () => {
    const [m] = helperParts([{ ...helper('수원은 주말 꽃가루가 낮음이에요. [블로그](https://blog.example/7)', [], []), proof: undefined, missing: undefined }] as TeamMember[])
    expect(m!.data!.facts[0]!.url).toBe('https://blog.example/7')
  })
})

describe('c17a r2: a counted ask with several points counts only items that state every point', () => {
  const ask = '아이패드 미니 8이랑 갤럭시 탭 S12 무게랑 배터리 용량 비교해줘'
  it('two weight-only rows do not end it: the judge\'s words for the battery run; at the due each row says the battery was not found', async () => {
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
    expect(s.queries).toEqual(['q', '태블릿 배터리 용량'])
    expect(urls(out)).toEqual(['https://apple.example/1', 'https://samsung.example/2'])
    expect(out).toContain('For https://apple.example/1, not found in anything read: 배터리 용량.')
    expect(out).toContain('For https://samsung.example/2, not found in anything read: 배터리 용량.')
  })
  it('rows that state every point end it in one round', async () => {
    const s = search([page('q', [row(1, '아이패드 미니 8', '293g, 배터리 5,078mAh', 'apple.example'), row(2, '갤럭시 탭 S12', '498g, 배터리 8,400mAh', 'samsung.example')])])
    const out = await checkedSearch(s, { ask: () => ask, write: agreeing(async () => JSON.stringify({ keep: [1, 2], asked: 2, points: ['무게', '배터리 용량'], holds: { 1: { 무게: '293g', '배터리 용량': '5,078mAh' }, 2: { 무게: '498g', '배터리 용량': '8,400mAh' } }, search: '더 찾기' })), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q'])
    expect(out).toContain('They hold the 2 asked for')
    expect(out).not.toContain('not found')
  })
})

describe('c17a r3: a helper cell holds only verified points', () => {
  const at = new Date().toISOString()
  const helper = (brief: string, said: string, extra: Partial<TeamMember>): TeamMember => ({ id: 'h', parentId: null, depth: 1, role: '조사', topic: '대상', brief, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said, said, ...extra })
  it('a quote for one point does not carry an unverified value of another point cited to the same page', () => {
    const [m] = helperParts([helper('라이트북 무게와 배터리 알려줘', '라이트북은 1.2kg이고 배터리는 90Wh예요. [제품](https://example.com/p)', { proof: [{ point: '무게', quote: '1.2kg', url: 'https://example.com/p' }], missing: ['배터리'] })])
    const text = m!.data!.facts.map(f => f.text).join(' ')
    expect(text).not.toContain('90Wh')
    expect(text).toContain('1.2kg')
    expect(text).toContain('배터리는 못 찾았어요.')
  })
  it('an unnamed invented value next to a verified one on the same page is not shown either', () => {
    const [m] = helperParts([helper('제주 렌터카 하루 요금이랑 보험료', '제주 렌터카는 하루 4만 2천 원, 보험은 1만 5천 원이에요 [업체](https://rent.example/jeju)', { proof: [{ point: '하루 요금', quote: '하루 4만 2천 원', url: 'https://rent.example/jeju' }], missing: ['보험료'] })])
    const text = m!.data!.facts.map(f => f.text).join(' ')
    expect(text).not.toContain('1만 5천')
    expect(text).toBe('하루 요금: 하루 4만 2천 원. 보험료는 못 찾았어요.')
  })
  it('judged with nothing verified and nothing marked missing: the cited prose is no cell, and the row is said not found', () => {
    const [m] = helperParts([helper('수원 이번 주말 꽃가루 농도 알려줘', '수원 꽃가루는 낮음이에요. [기사](https://example.com/a)', { proof: [] })])
    expect(m!.data).toBeUndefined()
    const table = mergedReport([m!], new Map(), [], true)
    expect(table).not.toContain('낮음')
    expect(table.split('\n')[0]).toContain('못 찾았어요')
  })
  it('on a page it read whole itself, its prose stands, and a point it states there is not said as not found', () => {
    const [m] = helperParts([helper('부산 해수욕장 수온이랑 파고', '해운대 수온은 22도예요 [해양청](https://sea.example/busan). 파고는 1.5m예요 [해양청](https://sea.example/busan)', { proof: [], missing: ['파고'], sources: ['https://sea.example/busan'] })], new Map([['h', new Set(['파고'])]]))
    const text = m!.data!.facts.map(f => f.text).join(' ')
    expect(text).toContain('22도')
    expect(text).toContain('1.5m')
    expect(text).not.toContain('못 찾았어요')
  })
  it('a point the read page\'s words do not state is still said as not found', () => {
    const [m] = helperParts([helper('부산 해수욕장 수온이랑 파고', '해운대 수온은 22도예요 [해양청](https://sea.example/busan)', { proof: [{ point: '수온', quote: '수온 22도', url: 'https://sea.example/busan' }], missing: ['파고'], sources: ['https://sea.example/busan'] })])
    expect(m!.data!.facts.map(f => f.text).join(' ')).toBe('해운대 수온은 22도예요. 파고는 못 찾았어요.')
  })
})
