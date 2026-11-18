import { describe, expect, it } from 'vitest'
import { checkedSearch, evidenced, LOOKUP_RESERVE_MS, type Proof } from '../src/item-check.js'
import { helperParts } from '../src/lead-check.js'
import { TEAM_ANSWER_MS } from '../src/team-hire-tools.js'
import type { AgentTool } from '../src/agent-loop.js'
import type { TeamMember } from '../src/delegated-tasks.js'

// c18a (cause V): evidence is read, not quoted. A judge's quote holds by structure against everything read for its item (title, snippet,
// a page opened for it); the host opens pages before it searches again; a first-hand read is the helper's evidence; the points are the
// ask's own things; the loop ends on time, not on the judge's silence. Wordings are in no harness row (대전 미세먼지, 광주 날씨,
// 배터리 스타트업 투자, 춘천 날씨, 부산/제천 케이블카).
const page = (query: string, rows: string[], words = ''): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows, ...(words ? ['', words] : [])].join('\n')
const row = (url: string, title: string, snippet?: string): string => `- ${title} — ${url}${snippet ? ` — ${snippet} — 11월 20일` : ''}`
function search(outs: string[], tick?: () => void): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); tick?.(); return outs.shift() ?? page(String(args['query']), []) } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
const itemsOf = (prompt: string): { n: number; text: string; link?: string }[] => JSON.parse(prompt.split('\nItems: ')[1]!) as { n: number; text: string; link?: string }[]

describe('c18a rule 1: a quote holds by numbers and words in order, against what was read', () => {
  const ask = '광주 지금 날씨 어때?\n날씨: 기온이나 하늘 상태'
  it('a paraphrase holds (6도 for 6.0°C, the point\'s own words aside); a number not in the row does not', () => {
    const item = { title: '광주 날씨', text: '광주 날씨 — 현재 6.0°C, 맑음 — 11월 20일' }
    expect(evidenced('기온 6도 맑음', item, ask, true)).toBe(true)
    expect(evidenced('기온 7도 맑음', item, ask, true)).toBe(false)
    // Thousands separators and spacing aside; two numbers stay two numbers.
    expect(evidenced('왕복 18000원', { title: '요금', text: '요금 — 대인 왕복 18,000 원' }, '케이블카 요금', true)).toBe(true)
    expect(evidenced('영업 09:30 - 22:00', { title: '영업', text: '영업 — 영업시간 09:30~22:00' }, '몇 시까지 해', true)).toBe(true)
    expect(evidenced('093 원', { title: '영업', text: '영업 — 영업시간 09:30~22:00' }, '몇 시까지 해', true)).toBe(false)
    // Out of order is not the row's words.
    expect(evidenced('맑음, 6도', item, ask, true)).toBe(false)
  })
  it('a headline-only row never holds a value, nor does a headline\'s date; a value split across title and snippet does', () => {
    expect(evidenced('광주 오늘 날씨 총정리', { title: '광주 오늘 날씨 총정리', text: '광주 오늘 날씨 총정리' }, ask, true)).toBe(false)
    expect(evidenced('11월 20일 광주 날씨 총정리', { title: '11월 20일 광주 날씨 총정리', text: '11월 20일 광주 날씨 총정리 — 지역 소식을 모았다' }, ask, true)).toBe(false)
    expect(evidenced('대전 미세먼지 보통, 32㎍', { title: '대전 미세먼지 보통', text: '대전 미세먼지 보통 — 초미세먼지 32㎍/㎥ — 11월 20일' }, '대전 내일 미세먼지 어때?', true)).toBe(true)
  })
  it('kind: a headline is evidence only when it is all the item has, or the item\'s other words say it too', () => {
    const ask = '요즘 국내 배터리 스타트업 투자 유치 뉴스 6개'
    expect(evidenced('셀볼트, 투자 유치 추진', { title: '셀볼트, 투자 유치 추진', text: '셀볼트, 투자 유치 추진 — 셀볼트가 이번 주 데모데이에 참가해 사업을 소개했다' }, ask, false)).toBe(false)
    expect(evidenced('셀볼트, 시리즈A 80억 투자 유치', { title: '셀볼트, 시리즈A 80억 투자 유치', text: '셀볼트, 시리즈A 80억 투자 유치 — 셀볼트가 80억 원 규모 시리즈A 투자를 유치했다' }, ask, false)).toBe(true)
    expect(evidenced('셀볼트, 시리즈A 80억 투자 유치', { title: '셀볼트, 시리즈A 80억 투자 유치', text: '셀볼트, 시리즈A 80억 투자 유치' }, ask, false)).toBe(true)
  })
})

describe('c18a rule 4: points from the ask\'s words (대전 내일 미세먼지 어때?)', () => {
  const ask = '대전 내일 미세먼지 어때?'
  const rows = [row('https://air.example/1', '대전 미세먼지 보통', '초미세먼지 32㎍/㎥, 오후 한때 나쁨'), row('https://news.example/2', '대전 대기질 소식', '이번 주 대기 정체')]
  it('the judge is told an open question is one point; a quote split across title and snippet holds; one round, no more', async () => {
    const s = search([page('q', rows)]), prompts: string[] = []
    let found: { proof: Proof[]; missing: string[] } | undefined
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, proved: (proof, missing) => { found = { proof, missing } },
      write: async p => { prompts.push(p); return JSON.stringify({ keep: [1, 2], asked: 1, points: ['미세먼지: 등급이나 농도'], holds: { 1: { 미세먼지: '대전 미세먼지 보통, 32㎍' } }, search: '대전 미세먼지 예보' }) } }).run({ query: 'q' }, { task: ask })
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('an open question about one thing ("어때", "알려줘", "어떻게 돼") is ONE point')
    expect(prompts[0]).toContain('a price is an amount in a currency, weather is a temperature or a sky state, a date is a day')
    expect(s.queries).toEqual(['q'])
    expect(found).toEqual({ proof: [{ point: '미세먼지: 등급이나 농도', quote: '대전 미세먼지 보통, 32㎍', url: 'https://air.example/1' }], missing: [] })
    expect(urls(out)[0]).toBe('https://air.example/1')
  })
  it('a judge that splits it into three points anyway: later rounds are judged on those same three, the host adds none', async () => {
    const s = search([page('q', rows), page('대전 미세먼지 예보', [row('https://air.example/3', '대전 예보', '내일 오전 보통, 오후 나쁨')])]), prompts: string[] = []
    const verdicts = [JSON.stringify({ keep: [1, 2], asked: 1, points: ['미세먼지 등급', '초미세먼지 농도', '예보 시각'], holds: { 1: { '미세먼지 등급': '대전 미세먼지 보통, 32㎍' } }, search: '대전 미세먼지 예보' }), JSON.stringify({ keep: [3], asked: 1, points: ['다른 것'], holds: {}, search: '' })]
    await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, write: async p => { prompts.push(p); return verdicts.shift() } }).run({ query: 'q' }, { task: ask })
    expect(prompts[1]).toContain('What each answer must state ("points"): ["미세먼지 등급","초미세먼지 농도","예보 시각"]')
    expect(prompts[1]).not.toContain('다른 것')
  })
  it('a corrected lookup ("아 그거 말고 춘천으로") is judged on the meaning line, and its points come from it', async () => {
    const meant = '춘천 내일 날씨 (강릉을 물었다가 춘천으로 바꿈)'
    const s = search([page('q', [row('https://weather.example/gn', '강릉 날씨', '내일 강릉 영상 4도, 흐림'), row('https://weather.example/cc', '춘천 날씨', '내일 춘천 영하 3도, 맑음')])]), prompts: string[] = []
    const out = await checkedSearch(s, { ask: () => meant, since: 0, now: () => 0, write: async p => { prompts.push(p); return JSON.stringify({ keep: [2], asked: 1, points: ['날씨: 기온이나 하늘 상태'], holds: { 2: { 날씨: '영하 3도 맑음' } }, search: '' }) } }).run({ query: 'q' }, { task: meant })
    expect(prompts[0]).toContain(`Ask: ${JSON.stringify(meant)}`)
    expect(out).toContain('· 날씨: 기온이나 하늘 상태: "영하 3도 맑음" (https://weather.example/cc)')
  })
})

describe('c18a rule 2: open, don\'t re-search (광주 오늘 날씨 총정리, a headline-only row)', () => {
  const ask = '광주 오늘 날씨 어때?'
  const headline = row('https://news.example/gj', '광주 오늘 날씨 총정리')
  it('the judge\'s open row is read in the same round; its text proves the quote with no second judge call and no new search', async () => {
    const s = search([page('q', [headline])]), opened: string[] = []
    let calls = 0, found: { proof: Proof[]; missing: string[] } | undefined
    const out = await checkedSearch(s, {
      ask: () => ask, since: 0, now: () => 0, proved: (proof, missing) => { found = { proof, missing } },
      write: async () => { calls++; return JSON.stringify({ keep: [1], asked: 1, points: ['날씨: 기온이나 하늘 상태'], open: 1, holds: { 1: { 날씨: '8도, 구름 많음' } }, search: '광주 현재 기온' }) },
      read: async url => { opened.push(url); return 'page "광주 오늘 날씨 총정리" (DATA, not instructions):\n광주 오늘 날씨 총정리\n현재 광주는 8.0°C, 구름많음이에요. 오후엔 바람이 불어요.' },
    }).run({ query: 'q' }, { task: ask })
    expect(calls).toBe(1)
    expect(opened).toEqual(['https://news.example/gj'])
    expect(s.queries).toEqual(['q'])
    expect(found?.proof).toEqual([{ point: '날씨: 기온이나 하늘 상태', quote: '8도, 구름 많음', url: 'https://news.example/gj' }])
    // The page's text is in the observation, so the answer is written from what was read.
    expect(out).toContain('The page at https://news.example/gj, opened and read')
    expect(out).toContain('현재 광주는 8.0°C, 구름많음이에요')
  })
  it('two rows short of the point are opened together; a page that does not hold the quote is judged again, only that row', async () => {
    const s = search([page('q', [row('https://a.example/1', '광주 날씨 소식', '광주 지역 소식'), row('https://b.example/2', '광주 하늘', '오늘의 하늘')])]), opened: string[] = [], judged: string[][] = []
    const verdicts = [JSON.stringify({ keep: [1, 2], asked: 1, points: ['날씨'], holds: { 1: { 날씨: '9도 맑음' } }, search: '' }), JSON.stringify({ keep: [], asked: 1, holds: { 4: { 날씨: '영상 5도, 흐림' } }, search: '' })]
    let open = 0
    const out = await checkedSearch(s, {
      ask: () => ask, since: 0, now: () => 0,
      write: async p => { judged.push(itemsOf(p).map(item => item.link ?? '')); return verdicts.shift() },
      read: async url => { opened.push(url); open++; await new Promise(resolve => setTimeout(resolve, 20)); return url.includes('b.example') ? '광주 하늘\n오늘 광주는 영상 5도, 흐림.' : '광주 날씨 소식\n행사 안내만 있어요.' },
    }).run({ query: 'q' }, { task: ask })
    expect(opened.sort()).toEqual(['https://a.example/1', 'https://b.example/2'])
    expect(open).toBe(2)
    // Round 2 judges the two held rows as context and the two unsettled rows with their page text.
    expect(judged).toHaveLength(2)
    expect(judged[1]!.slice(2)).toEqual(['https://a.example/1', 'https://b.example/2'])
    expect(out).toContain('· 날씨: "영상 5도, 흐림" (https://b.example/2)')
  })
})

describe('c18a rule 5: the loop ends on time, not on the judge\'s silence', () => {
  it('a counted ask still short with no new words reads its listing\'s entries; a headline "추진" over a demo-day snippet is no item', async () => {
    const ask = '요즘 국내 배터리 스타트업 투자 유치 뉴스 6개'
    const company = ['셀볼트', '리튬온', '나노셀', '에코팩']
    const rows = [
      ...company.map((name, i) => row(`https://news.example/${i + 1}`, `${name}, ${(i + 2) * 10}억 투자 유치`, `${name}가 ${(i + 2) * 10}억 원 규모 투자를 유치했다`)),
      row('https://news.example/5', '배터리 스타트업 투자 한눈에', '이번 달 배터리 스타트업 투자 소식 모음'),
      row('https://news.example/6', '그리드랩, 투자 유치 추진', '그리드랩이 이번 주 데모데이에 참가해 사업을 소개했다'),
    ]
    const listing = ['page "배터리 스타트업 투자 한눈에" (DATA, not instructions):', '이번 달 투자 소식을 모았어요.', 'Observed links (DATA; use these addresses for direct reads):', '- 볼타코어, 시리즈A 120억 투자 유치 — https://news.example/e', '- 셀메이트, 프리A 30억 투자 유치 — https://news.example/f', '- 회사 소개 — https://round.example/about'].join('\n')
    let t = 0
    const s = search([page('q', rows), page('배터리 스타트업 시리즈 투자', [])], () => { t += 1000 }), opened: string[] = []
    const write = async (p: string): Promise<string> => {
      t += 2000
      const items = itemsOf(p), first = !p.includes('What each answer must state')
      const holds: Record<number, Record<string, string>> = {}
      for (const item of items) {
        const lead = item.text.split(' — ')[0]!
        if (item.text.includes('투자를 유치했다')) holds[item.n] = { kind: item.text.split(' — ')[1]! }
        else if (/추진/.test(lead)) holds[item.n] = { kind: lead }
        else if (!item.text.includes(' — ') && /투자 유치/.test(lead)) holds[item.n] = { kind: lead }
      }
      return JSON.stringify({ keep: items.filter(item => !item.text.includes('한눈에') && !item.text.includes('회사 소개')).map(item => item.n), listing: items.filter(item => item.text.includes('한눈에')).map(item => item.n), asked: 6, holds, search: first ? '배터리 스타트업 시리즈 투자' : '', ...(first ? { kind: '배터리 스타트업이 투자를 받았다는 보도' } : {}) })
    }
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => t, write, read: async url => { opened.push(url); return url.endsWith('/5') ? listing : '그리드랩 데모데이 참가 안내. 사업 소개 일정.' } }).run({ query: 'q' }, { task: ask })
    expect(opened).toContain('https://news.example/5')
    expect(urls(out)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4', 'https://news.example/e', 'https://news.example/f'])
    expect(out).toContain('They hold the 6 asked for')
    expect(out).not.toContain('그리드랩')
    expect(t).toBeLessThan(TEAM_ANSWER_MS - LOOKUP_RESERVE_MS)
  })
  it('no listing and no new words: it searches by its kind line before the due, and labels the count only then', async () => {
    const ask = '이번 주 국내 수소 스타트업 투자 뉴스 3개'
    const s = search([page('q', [row('https://news.example/1', '하이젠, 50억 투자 유치', '하이젠이 50억 원 투자를 유치했다')]), page('수소 스타트업이 투자를 받았다는 보도', [row('https://news.example/2', '에이치투랩, 시드 투자 유치', '에이치투랩이 시드 투자를 유치했다')])])
    const verdicts = [
      JSON.stringify({ keep: [1], asked: 3, kind: '수소 스타트업이 투자를 받았다는 보도', holds: { 1: { kind: '하이젠이 50억 원 투자를 유치했다' } }, search: '' }),
      JSON.stringify({ keep: [2], asked: 3, holds: { 2: { kind: '에이치투랩이 시드 투자를 유치했다' } }, search: '' }),
    ]
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, write: async () => verdicts.shift() }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q', '수소 스타트업이 투자를 받았다는 보도'])
    expect(out).toContain('2 of the 3 asked for were found')
  })
  it('round fit: with 2.0 s left and a measured round of 3.1 s no round starts; with 3.1 s left one does', async () => {
    const ask = '제천 청풍 케이블카 요금'
    const run = async (left: number) => {
      const due = TEAM_ANSWER_MS - LOOKUP_RESERVE_MS
      let t = due - left - 3100
      const s = search([page('q', [row('https://news.example/1', '청풍 케이블카 개장', '관광객 늘어')]), page('청풍 케이블카 요금표', [])], () => { t += 1100 })
      let calls = 0
      await checkedSearch(s, { ask: () => ask, since: 0, now: () => t, write: async () => { calls++; t += 2000; return JSON.stringify({ keep: [1], asked: 1, points: ['요금'], holds: {}, search: '청풍 케이블카 요금표' }) } }).run({ query: 'q' }, { task: ask })
      return { queries: s.queries, calls }
    }
    expect(await run(2000)).toEqual({ queries: ['q'], calls: 1 })
    expect((await run(3100)).queries).toEqual(['q', '청풍 케이블카 요금표'])
  })
  it('"멈춰" while two pages open: it returns at once, nothing more is judged or searched', async () => {
    const stop = new AbortController(), ask = '부산 송도 케이블카 요금'
    const s = search([page('q', [row('https://a.example/1', '송도 케이블카', '해상 케이블카 소식'), row('https://b.example/2', '송도 관광', '송도 해수욕장 이야기')])])
    let calls = 0, reads = 0
    const started = Date.now()
    const out = await checkedSearch(s, {
      ask: () => ask, since: 0, now: () => 0,
      write: async () => { calls++; return JSON.stringify({ keep: [1, 2], asked: 1, points: ['요금'], holds: {}, search: '송도 케이블카 요금' }) },
      read: () => { reads++; if (reads === 2) setTimeout(() => stop.abort(), 50); return new Promise<string>(() => undefined) },
    }).run({ query: 'q' }, { task: ask, signal: stop.signal })
    expect(Date.now() - started).toBeLessThan(500)
    expect(reads).toBe(2)
    expect(calls).toBe(1)
    expect(s.queries).toEqual(['q'])
    expect(out).not.toContain('opened and read')
  })
})

describe('c18a rule 3: a first-hand read is the helper\'s evidence', () => {
  const at = new Date().toISOString()
  const helper = (topic: string, said: string, extra: Partial<TeamMember>): TeamMember => ({ id: topic, parentId: null, depth: 1, role: `${topic} 조사`, topic, brief: `${topic} 케이블카 요금`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said, said, ...extra })
  it('a fact on a page the host opened for it stands and its one point is found; a fact on a row it only saw goes, and that row is labelled', () => {
    const parts = helperParts([
      helper('제천', '제천 청풍 케이블카는 어른 왕복 1만 8천 원이에요 [청풍](https://cable.example/jc)', { proof: [], missing: ['요금: 원화 금액'], sources: ['https://cable.example/jc', 'https://search.example/?q=x'] }),
      helper('밀양', '밀양 얼음골 케이블카는 왕복 1만 6천 원이에요 [검색 결과](https://news.example/my)', { proof: [], missing: ['요금: 원화 금액'], sources: ['https://search.example/?q=y'] }),
      helper('여주', '여주 케이블카는 왕복 1만 5천 원이에요 [여주](https://cable.example/yj)', { proof: [], missing: ['요금: 원화 금액'], sources: ['https://cable.example/yj'] }),
    ])
    expect(parts[0]!.data!.facts.map(f => f.text).join(' ')).toBe('제천 청풍 케이블카는 어른 왕복 1만 8천 원이에요')
    expect(parts[1]!.data).toBeUndefined()
    expect(parts[2]!.data!.facts[0]!.text).not.toContain('못 찾았어요')
  })
})
