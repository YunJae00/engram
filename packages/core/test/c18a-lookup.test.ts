import { describe, expect, it } from 'vitest'
import { checkedSearch, evidenced, judgedItems, LOOKUP_RESERVE_MS, stated, type Proof } from '../src/item-check.js'
import { helperParts } from '../src/lead-check.js'
import { TEAM_ANSWER_MS } from '../src/team-hire-tools.js'
import type { AgentTool } from '../src/agent-loop.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { agreeing, STATED_PROMPT } from './agreeing.js'

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
    expect(evidenced('셀볼트가 80억 원 규모 시리즈A 투자를 유치했다', { title: '셀볼트, 시리즈A 80억 투자 유치', text: '셀볼트, 시리즈A 80억 투자 유치 — 셀볼트가 80억 원 규모 시리즈A 투자를 유치했다' }, ask, false)).toBe(true)
    // c18a r2: with words beyond the headline, the headline is not the statement; the item's own sentence is.
    expect(evidenced('셀볼트, 시리즈A 80억 투자 유치', { title: '셀볼트, 시리즈A 80억 투자 유치', text: '셀볼트, 시리즈A 80억 투자 유치 — 셀볼트가 80억 원 규모 시리즈A 투자를 유치했다' }, ask, false)).toBe(false)
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
      write: agreeing(async p => { prompts.push(p); return JSON.stringify({ keep: [1, 2], asked: 1, points: ['미세먼지: 등급이나 농도'], holds: { 1: { 미세먼지: '대전 미세먼지 보통, 32㎍' } }, search: '대전 미세먼지 예보' }) }) }).run({ query: 'q' }, { task: ask })
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
    await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, write: agreeing(async p => { prompts.push(p); return verdicts.shift() }) }).run({ query: 'q' }, { task: ask })
    expect(prompts[1]).toContain('What each answer must state ("points"): ["미세먼지 등급","초미세먼지 농도","예보 시각"]')
    expect(prompts[1]).not.toContain('다른 것')
  })
  it('a corrected lookup ("아 그거 말고 춘천으로") is judged on the meaning line, and its points come from it', async () => {
    const meant = '춘천 내일 날씨 (강릉을 물었다가 춘천으로 바꿈)'
    const s = search([page('q', [row('https://weather.example/gn', '강릉 날씨', '내일 강릉 영상 4도, 흐림'), row('https://weather.example/cc', '춘천 날씨', '내일 춘천 영하 3도, 맑음')])]), prompts: string[] = []
    const out = await checkedSearch(s, { ask: () => meant, since: 0, now: () => 0, write: agreeing(async p => { prompts.push(p); return JSON.stringify({ keep: [2], asked: 1, points: ['날씨: 기온이나 하늘 상태'], holds: { 2: { 날씨: '영하 3도 맑음' } }, search: '' }) }) }).run({ query: 'q' }, { task: meant })
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
      write: agreeing(async () => { calls++; return JSON.stringify({ keep: [1], asked: 1, points: ['날씨: 기온이나 하늘 상태'], open: 1, holds: { 1: { 날씨: '8도, 구름 많음' } }, search: '광주 현재 기온' }) }),
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
      write: agreeing(async p => { judged.push(itemsOf(p).map(item => item.link ?? '')); return verdicts.shift() }),
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
    const write = agreeing(async (p: string): Promise<string> => {
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
    })
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
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, write: agreeing(async () => verdicts.shift()) }).run({ query: 'q' }, { task: ask })
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
      await checkedSearch(s, { ask: () => ask, since: 0, now: () => t, write: agreeing(async () => { calls++; t += 2000; return JSON.stringify({ keep: [1], asked: 1, points: ['요금'], holds: {}, search: '청풍 케이블카 요금표' }) }) }).run({ query: 'q' }, { task: ask })
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
      write: agreeing(async () => { calls++; return JSON.stringify({ keep: [1, 2], asked: 1, points: ['요금'], holds: {}, search: '송도 케이블카 요금' }) }),
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

// c18a r2 (review r1): words being there is not the point being stated. Wordings are in no harness row (생수 값, 노트북 무게, 축구 이적,
// 로봇 스타트업 투자).
describe('c18a r2 #1: a value is in the point\'s units, a kind quote is a whole statement', () => {
  it('a point that names its units holds only a figure written in one of them', () => {
    const price = '생수 2L 가격: 원화 금액 (원)', item = { title: '생수값 소식', text: '생수값 소식 — 생수 2L 값이 3% 올라 1,250원이 됐다' }
    expect(evidenced('3% 올라', item, price, price)).toBe(false)
    expect(evidenced('1,250원', item, price, price)).toBe(true)
    expect(evidenced('1만 2천 원', { title: '할인', text: '할인 — 묶음은 1만 2천 원' }, price, price)).toBe(true)
    expect(evidenced('2026년 3월', { title: '할인', text: '할인 — 2026년 3월 출시' }, price, price)).toBe(false)
    const weight = '노트북 무게: 킬로그램 (kg, g)'
    expect(evidenced('15% 가벼워', { title: '신형 노트북', text: '신형 노트북 — 전작보다 15% 가벼워졌다' }, weight, weight)).toBe(false)
    expect(evidenced('1.2kg', { title: '신형 노트북', text: '신형 노트북 — 무게 1.2 kg' }, weight, weight)).toBe(true)
    // A measure that can be words names no units: a sky state still holds.
    const sky = '날씨: 기온이나 하늘 상태'
    expect(evidenced('흐림', { title: '세종 날씨', text: '세종 날씨 — 오후 흐림' }, sky, sky)).toBe(true)
  })
  it('a kind quote covers the end of its sentence: a fragment that leaves off "not done" is no evidence', () => {
    const kind = '구단이 선수를 영입했다는 보도'
    const pending = { title: '수원, 센터백 영입 협상', text: '수원, 센터백 영입 협상 — 수원이 센터백 영입 협상을 진행 중이지만 아직 계약하지 않았다' }
    expect(evidenced('센터백 영입 협상', pending, kind, false)).toBe(false)
    expect(evidenced('수원, 센터백 영입 협상', pending, kind, false)).toBe(false)
    const done = { title: '수원, 센터백 영입', text: '수원, 센터백 영입 — 수원이 센터백 박도현을 영입했다고 2일 밝혔다. 계약 기간은 3년이다' }
    expect(evidenced('박도현을 영입했다고 2일 밝혔다', done, kind, false)).toBe(true)
    expect(evidenced('센터백 박도현을 영입', done, kind, false)).toBe(false)
    // In English the denial sits inside the sentence: no word of it may be skipped.
    const en = { title: 'Robotics startup Arko', text: 'Robotics startup Arko — Arko has not raised its Series A yet' }
    expect(evidenced('Arko raised its Series A yet', en, 'news of a startup raising funding', false)).toBe(false)
    // An ending the text adds to a word the quote has, and a particle the quote adds, are still the same words.
    expect(evidenced('로봇랩 시리즈B 유치', { title: '로봇랩', text: '로봇랩 — 로봇랩이 시리즈B를 유치' }, '로봇 스타트업 투자 보도', false)).toBe(true)
  })
  it('the judge is asked for units and whole sentences; its percentage for a price and its fragment for a kind are not holds', async () => {
    const prompts: string[] = []
    const items = [{ title: '생수값 소식', text: '생수값 소식 — 생수 2L 값이 3% 올라 1,250원이 됐다' }, { title: '수원, 센터백 영입 협상', text: '수원, 센터백 영입 협상 — 수원이 센터백 영입 협상을 진행 중이지만 아직 계약하지 않았다' }]
    const verdict = await judgedItems('생수 2L 값 얼마야', items, async p => { prompts.push(p); return JSON.stringify({ keep: [1], points: ['생수 2L 가격: 원화 금액 (원)'], holds: { 1: { '생수 2L 가격': '3% 올라' } } }) })
    expect(prompts[0]).toContain('in parentheses ("가격: 원화 금액 (원)"')
    expect(prompts[0]).toContain('through the end of their sentence')
    expect(verdict?.holds).toEqual([])
    const kinds = await judgedItems('센터백 영입 소식 2개', items, async () => JSON.stringify({ keep: [2], points: [], kind: '구단이 선수를 영입했다는 보도', holds: { 2: { kind: '센터백 영입 협상' } } }))
    expect(kinds?.holds).toEqual([])
  })
})

describe('c18a r2 #2: a page\'s fact covers the points it states, not the page', () => {
  const at = new Date().toISOString()
  const member = (said: string, proof: Proof[]): TeamMember => ({ id: 'h', parentId: null, depth: 1, role: '조사', topic: '에어북', brief: '에어북 무게와 화면 크기', lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said, said, proof, missing: [], sources: ['https://maker.example/air'] })
  it('a verified point the helper\'s words on that page leave out stays in its cell, with the page\'s name', () => {
    const [part] = helperParts([member('에어북 무게는 980g이에요. [메이커](https://maker.example/air)', [{ point: '무게', quote: '980g', url: 'https://maker.example/air' }, { point: '화면 크기', quote: '13.6인치', url: 'https://maker.example/air' }])])
    expect(part!.data!.facts.map(f => f.text)).toEqual(['에어북 무게는 980g이에요.', '화면 크기: 13.6인치'])
    expect(part!.data!.facts.every(f => f.site === '메이커')).toBe(true)
  })
  it('a point the helper\'s words already state is not repeated', () => {
    const [part] = helperParts([member('에어북 무게는 980g, 화면 크기는 13.6인치예요. [메이커](https://maker.example/air)', [{ point: '무게', quote: '980g', url: 'https://maker.example/air' }, { point: '화면 크기', quote: '13.6인치', url: 'https://maker.example/air' }])])
    expect(part!.data!.facts).toHaveLength(1)
  })
})

// c18a r3 (review r2): words being in the text, even a whole sentence or a figure, is not their stating the point; that is meaning. A quote is
// evidence only when a blind read (the quick model, shown each quote alone beside what it is offered as) says its words state it. The fake
// blind reader below answers by a table of what each quote means, standing in for the model's reading; what the tests check is the host:
// the read sees only the words and the point, its "no" (or no answer) leaves the quote unproven on every path, and its "yes" proves it.
describe('c18a r3: a quote is evidence only when a blind read says its words state the point', () => {
  const reader = (meaning: Record<string, boolean>, seen: string[] = []) => async (prompt: string): Promise<string> => {
    seen.push(prompt)
    const entries = JSON.parse(prompt.split('\nEntries: ')[1]!) as { n: number; words: string }[]
    return JSON.stringify({ states: entries.filter(e => meaning[e.words]).map(e => e.n) })
  }
  // One quick model: the judge's answer for a judge prompt, the blind reader's for the read.
  const model = (verdict: () => string, meaning: Record<string, boolean>, seen: string[] = []) => async (p: string): Promise<string> => p.includes(STATED_PROMPT) ? reader(meaning, seen)(p) : verdict()

  it('the reviewer\'s price: a judge that leaves out the units still cannot make "4%가량 하락" a price', async () => {
    const items = [{ title: '주가 소식', text: '주가 소식 — 주가는 4%가량 하락했다' }]
    const v = await judgedItems('주가 얼마야', items, model(() => JSON.stringify({ keep: [1], points: ['주가: 원화 금액'], holds: { 1: { 주가: '4%가량 하락' } } }), { '4%가량 하락': false }))
    expect(v?.holds).toEqual([])
    expect(v?.quotes).toEqual({ 1: { '주가: 원화 금액': '4%가량 하락' } })
  })
  it('the reviewer\'s kind: a whole sentence saying funding was not received is no report of funding received', async () => {
    const items = [{ title: '투자 유치 추진', text: '투자 유치 추진 — 로봇랩이 투자 유치를 추진 중이며 아직 투자를 받지 못했다' }]
    const quote = '로봇랩이 투자 유치를 추진 중이며 아직 투자를 받지 못했다'
    const v = await judgedItems('스타트업 투자 뉴스 3개', items, model(() => JSON.stringify({ keep: [1], points: [], kind: '스타트업이 투자를 받았다는 보도', holds: { 1: { kind: quote } } }), { [quote]: false }))
    expect(v?.holds).toEqual([])
  })
  it('new wordings: a fare change is no fare, a "not signed yet" transfer is no signing; a real fare and a real signing are', async () => {
    const seen: string[] = []
    const items = [
      { title: '광역버스 요금 조정', text: '광역버스 요금 조정 — 광역버스 기본요금이 12% 오른다' },
      { title: '광역버스 요금표', text: '광역버스 요금표 — 광역버스 기본요금은 3,000원이다' },
      { title: '수원, 윙어 영입 근접', text: '수원, 윙어 영입 근접 — 수원이 윙어 김하람과 협상 중이나 아직 서명하지 않았다' },
      { title: '대전, 윙어 영입', text: '대전, 윙어 영입 — 대전이 윙어 이도윤을 영입했다고 5일 밝혔다' },
    ]
    const meaning = { '기본요금이 12% 오른다': false, '기본요금은 3,000원이다': true, '수원이 윙어 김하람과 협상 중이나 아직 서명하지 않았다': false, '대전이 윙어 이도윤을 영입했다고 5일 밝혔다': true }
    const fare = await judgedItems('광역버스 요금 얼마야', items.slice(0, 2), model(() => JSON.stringify({ keep: [1, 2], points: ['광역버스 요금: 원화 금액'], holds: { 1: { '광역버스 요금': '기본요금이 12% 오른다' }, 2: { '광역버스 요금': '기본요금은 3,000원이다' } } }), meaning, seen))
    expect(fare?.holds).toEqual([2])
    // The read is blind: each quote beside its point, never the item's headline, its other words, or the ask.
    expect(seen[0]).toContain('"offered as":"광역버스 요금: 원화 금액","words":"기본요금이 12% 오른다"')
    expect(seen[0]).not.toContain('요금 조정')
    expect(seen[0]).not.toContain('얼마야')
    const signings = await judgedItems('K리그 영입 소식 2개', items.slice(2), model(() => JSON.stringify({ keep: [1, 2], points: [], kind: '구단이 선수를 영입했다는 보도', holds: { 1: { kind: '수원이 윙어 김하람과 협상 중이나 아직 서명하지 않았다' }, 2: { kind: '대전이 윙어 이도윤을 영입했다고 5일 밝혔다' } } }), meaning, seen))
    expect(signings?.holds).toEqual([2])
    expect(seen[1]).toContain('"offered as":"one of: 구단이 선수를 영입했다는 보도"')
  })
  it('no blind answer in time (or an unreadable one): nothing is proven, and quotes that are not there are never sent to the read', async () => {
    expect(await stated([{ point: '요금: 원화 금액', quote: '3,000원' }], async () => 'not json', 1000)).toBeUndefined()
    expect(await stated([{ point: '요금: 원화 금액', quote: '3,000원' }], () => new Promise(() => undefined), 20)).toBeUndefined()
    const seen: string[] = []
    const v = await judgedItems('요금 얼마야', [{ title: '요금표', text: '요금표 — 기본요금은 3,000원이다' }], async p => { seen.push(p); return p.includes(STATED_PROMPT) ? 'sorry' : JSON.stringify({ keep: [1], points: ['요금: 원화 금액'], holds: { 1: { 요금: '기본요금은 3,000원이다' } } }) })
    expect(v?.holds).toEqual([])
    // A quote not in the item is settled by structure alone: no read is asked.
    seen.length = 0
    await judgedItems('요금 얼마야', [{ title: '요금표', text: '요금표 — 기본요금은 3,000원이다' }], async p => { seen.push(p); return JSON.stringify({ keep: [1], points: ['요금: 원화 금액'], holds: { 1: { 요금: '4,000원' } } }) })
    expect(seen.filter(p => p.includes(STATED_PROMPT))).toHaveLength(0)
  })
  it('a page opened later: the judge\'s quote that the page holds is still read blind; a page sentence saying "not yet" proves nothing', async () => {
    const ask = '세종 신규 노선 개통일 알려줘', headline = row('https://news.example/sj', '세종 신규 버스 노선')
    const quote = '신규 노선은 아직 개통일이 정해지지 않았다'
    const s = search([page('q', [headline])]), seen: string[] = []
    let found: { proof: Proof[]; missing: string[] } | undefined
    await checkedSearch(s, {
      ask: () => ask, since: 0, now: () => 0, proved: (proof, missing) => { found = { proof, missing } },
      write: model(() => JSON.stringify({ keep: [1], asked: 1, points: ['개통일: 날짜'], open: 1, holds: { 1: { 개통일: quote } }, search: '' }), { [quote]: false }, seen),
      read: async () => `세종 신규 버스 노선\n${quote}. 시는 연내 발표할 계획이다.`,
    }).run({ query: 'q' }, { task: ask })
    // The page held the words, so they were read blind (again on each later judgment that offers them), and every "no" left the date unproven.
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every(p => p.includes(`"words":"${quote}"`))).toBe(true)
    expect(found?.proof).toEqual([])
    expect(found?.missing).toEqual(['개통일: 날짜'])
  })
})
