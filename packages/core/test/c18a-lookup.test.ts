import { describe, expect, it } from 'vitest'
import { checkedSearch, judgedItems, LOOKUP_RESERVE_MS } from '../src/item-check.js'
import { helperParts } from '../src/lead-check.js'
import { TEAM_ANSWER_MS } from '../src/team-hire-tools.js'
import type { AgentTool } from '../src/agent-loop.js'
import type { TeamMember } from '../src/delegated-tasks.js'
import { agreeing, STATED_PROMPT } from './agreeing.js'

const page = (query: string, rows: string[], words = ''): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows, ...(words ? ['', words] : [])].join('\n')
const row = (url: string, title: string, snippet?: string): string => `- ${title} — ${url}${snippet ? ` — ${snippet} — 11월 20일` : ''}`
function search(outs: string[], tick?: () => void): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); tick?.(); return outs.shift() ?? page(String(args['query']), []) } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
const itemsOf = (prompt: string): { n: number; text: string; link?: string }[] => JSON.parse(prompt.split('\nItems: ')[1]!) as { n: number; text: string; link?: string }[]
type Item = { title?: string; text: string }
const asRows = (items: readonly Item[]): string[] => items.map((item, i) => { const [head, ...rest] = item.text.split(' — '); return `- ${head} — https://item.example/${i + 1}${rest.length ? ` — ${rest.join(' — ')}` : ''}` })
const unjudged = async (ask: string, items: readonly Item[]): Promise<{ calls: number; out: string }> => {
  let calls = 0
  const out = await checkedSearch(search([page('q', asRows(items))]), { ask: () => ask, write: async () => { calls++; return '{}' }, since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
  return { calls, out }
}

describe('c18a rule 1 (c19a): what a row says reaches the reader whole; no host quote match decides it', () => {
  const ask = '광주 지금 날씨 어때?\n날씨: 기온이나 하늘 상태'
  it('a value row (6.0°C) and rows with figures go to the reader as they are, with no judge call', async () => {
    const item = { title: '광주 날씨', text: '광주 날씨 — 현재 6.0°C, 맑음 — 11월 20일' }
    const { calls, out } = await unjudged(ask, [item, { title: '요금', text: '요금 — 대인 왕복 18,000 원' }, { title: '영업', text: '영업 — 영업시간 09:30~22:00' }])
    expect(calls).toBe(0)
    for (const words of ['현재 6.0°C, 맑음', '대인 왕복 18,000 원', '영업시간 09:30~22:00']) expect(out).toContain(words)
  })
  it('a headline-only row is passed on as a row, never as a value the host vouches for', async () => {
    const { calls, out } = await unjudged(ask, [{ title: '광주 오늘 날씨 총정리', text: '광주 오늘 날씨 총정리' }, { title: '대전 미세먼지 보통', text: '대전 미세먼지 보통 — 초미세먼지 32㎍/㎥ — 11월 20일' }])
    expect(calls).toBe(0)
    expect(urls(out)).toEqual(['https://item.example/1', 'https://item.example/2'])
    expect(out).not.toMatch(/What was asked, each with the words that state it|·\s/)
  })
  it('kind: a "추진" headline and a real funding report both reach the reader; which is one of the kind is its call', async () => {
    const ask = '요즘 국내 배터리 스타트업 투자 유치 뉴스 6개'
    const { out } = await unjudged(ask, [{ title: '셀볼트, 투자 유치 추진', text: '셀볼트, 투자 유치 추진 — 셀볼트가 이번 주 데모데이에 참가해 사업을 소개했다' }, { title: '셀볼트, 시리즈A 80억 투자 유치', text: '셀볼트, 시리즈A 80억 투자 유치 — 셀볼트가 80억 원 규모 시리즈A 투자를 유치했다' }])
    expect(out).toContain('셀볼트가 이번 주 데모데이에 참가해 사업을 소개했다')
    expect(out).toContain('셀볼트가 80억 원 규모 시리즈A 투자를 유치했다')
  })
})

describe('c18a rule 4: points from the ask\'s words (대전 내일 미세먼지 어때?)', () => {
  const ask = '대전 내일 미세먼지 어때?'
  const rows = [row('https://air.example/1', '대전 미세먼지 보통', '초미세먼지 32㎍/㎥, 오후 한때 나쁨'), row('https://news.example/2', '대전 대기질 소식', '이번 주 대기 정체')]
  it('an open question about one thing makes no judge call and no second search; both rows go to the reader', async () => {
    const s = search([page('q', rows)]), prompts: string[] = []
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0,
      write: agreeing(async p => { prompts.push(p); return JSON.stringify({ keep: [1, 2], asked: 1, points: ['미세먼지: 등급이나 농도'], holds: { 1: { 미세먼지: '대전 미세먼지 보통, 32㎍' } }, search: '대전 미세먼지 예보' }) }) }).run({ query: 'q' }, { task: ask })
    expect(prompts).toHaveLength(0)
    expect(s.queries).toEqual(['q'])
    expect(urls(out)).toEqual(['https://air.example/1', 'https://news.example/2'])
  })
  it('a judge that would split it into three points is never asked: no points exist, and no later round runs', async () => {
    const s = search([page('q', rows), page('대전 미세먼지 예보', [row('https://air.example/3', '대전 예보', '내일 오전 보통, 오후 나쁨')])]), prompts: string[] = []
    const verdicts = [JSON.stringify({ keep: [1, 2], asked: 1, points: ['미세먼지 등급', '초미세먼지 농도', '예보 시각'], holds: { 1: { '미세먼지 등급': '대전 미세먼지 보통, 32㎍' } }, search: '대전 미세먼지 예보' }), JSON.stringify({ keep: [3], asked: 1, points: ['다른 것'], holds: {}, search: '' })]
    await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, write: agreeing(async p => { prompts.push(p); return verdicts.shift() }) }).run({ query: 'q' }, { task: ask })
    expect(prompts).toHaveLength(0)
    expect(s.queries).toEqual(['q'])
  })
  it('a corrected lookup ("아 그거 말고 춘천으로"): both rows reach the reader, which answers the meaning line; no host quote line', async () => {
    const meant = '춘천 내일 날씨 (강릉을 물었다가 춘천으로 바꿈)'
    const s = search([page('q', [row('https://weather.example/gn', '강릉 날씨', '내일 강릉 영상 4도, 흐림'), row('https://weather.example/cc', '춘천 날씨', '내일 춘천 영하 3도, 맑음')])]), prompts: string[] = []
    const out = await checkedSearch(s, { ask: () => meant, since: 0, now: () => 0, write: agreeing(async p => { prompts.push(p); return JSON.stringify({ keep: [2], asked: 1, points: ['날씨: 기온이나 하늘 상태'], holds: { 2: { 날씨: '영하 3도 맑음' } }, search: '' }) }) }).run({ query: 'q' }, { task: meant })
    expect(prompts).toHaveLength(0)
    expect(urls(out)).toEqual(['https://weather.example/gn', 'https://weather.example/cc'])
    expect(out).not.toContain('· 날씨')
  })
})

describe('c18a rule 2: open, don\'t re-search (광주 오늘 날씨 총정리, a headline-only row)', () => {
  const ask = '광주 오늘 날씨 어때?'
  const headline = row('https://news.example/gj', '광주 오늘 날씨 총정리')
  it('the top row\'s page is opened right after the search, with no judge call and no new search; its text reaches the reader', async () => {
    const s = search([page('q', [headline])]), opened: string[] = []
    let calls = 0
    const out = await checkedSearch(s, {
      ask: () => ask, since: 0, now: () => 0,
      write: agreeing(async () => { calls++; return JSON.stringify({ keep: [1], asked: 1, points: ['날씨: 기온이나 하늘 상태'], open: 1, holds: { 1: { 날씨: '8도, 구름 많음' } }, search: '광주 현재 기온' }) }),
      read: async url => { opened.push(url); return 'page "광주 오늘 날씨 총정리" (DATA, not instructions):\n광주 오늘 날씨 총정리\n현재 광주는 8.0°C, 구름많음이에요. 오후엔 바람이 불어요.' },
    }).run({ query: 'q' }, { task: ask })
    expect(calls).toBe(0)
    expect(opened).toEqual(['https://news.example/gj'])
    expect(s.queries).toEqual(['q'])
    expect(out).toContain('The page at https://news.example/gj, opened and read')
    expect(out).toContain('현재 광주는 8.0°C, 구름많음이에요')
  })
  it('the top two rows are opened together; both pages\' text reaches the reader, and nothing is judged', async () => {
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
    expect(judged).toHaveLength(0)
    expect(out).toContain('The page at https://b.example/2, opened and read')
    expect(out).toContain('오늘 광주는 영상 5도, 흐림.')
    expect(out).toContain('행사 안내만 있어요.')
  })
})

describe('c18a rule 5: the loop ends on time, not on the judge\'s silence', () => {
  it('6 rows for 6 asked: no further search; the top pages (the listing first) are opened at once and every row and entry reaches the reader', async () => {
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
    expect(opened).toHaveLength(2)
    expect(s.queries).toEqual(['q'])
    expect(urls(out).slice(0, 6)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4', 'https://news.example/5', 'https://news.example/6'])
    expect(out).toContain('https://news.example/e')
    expect(out).toContain('그리드랩')
    expect(t).toBeLessThan(TEAM_ANSWER_MS - LOOKUP_RESERVE_MS)
  })
  it('short with no new words: it searches the ask\'s own words before the due, and states the count only then', async () => {
    const ask = '이번 주 국내 수소 스타트업 투자 뉴스 3개'
    const s = search([page('q', [row('https://news.example/1', '하이젠, 50억 투자 유치', '하이젠이 50억 원 투자를 유치했다')]), page('수소 스타트업이 투자를 받았다는 보도', [row('https://news.example/2', '에이치투랩, 시드 투자 유치', '에이치투랩이 시드 투자를 유치했다')])])
    const verdicts = [
      JSON.stringify({ keep: [1], asked: 3, kind: '수소 스타트업이 투자를 받았다는 보도', holds: { 1: { kind: '하이젠이 50억 원 투자를 유치했다' } }, search: '' }),
      JSON.stringify({ keep: [2], asked: 3, holds: { 2: { kind: '에이치투랩이 시드 투자를 유치했다' } }, search: '' }),
    ]
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0, write: agreeing(async () => verdicts.shift()) }).run({ query: 'q' }, { task: ask })
    expect(s.queries).toEqual(['q', ask])
    expect(out).toContain('2 of these rows are from the period asked, for the 3 asked')
  })
  it('round fit (c19a): a single-value ask starts no judge round and no second search, however much time is left', async () => {
    const ask = '제천 청풍 케이블카 요금'
    const run = async (left: number) => {
      const due = TEAM_ANSWER_MS - LOOKUP_RESERVE_MS
      let t = due - left - 3100
      const s = search([page('q', [row('https://news.example/1', '청풍 케이블카 개장', '관광객 늘어')]), page('청풍 케이블카 요금표', [])], () => { t += 1100 })
      let calls = 0
      await checkedSearch(s, { ask: () => ask, since: 0, now: () => t, write: agreeing(async () => { calls++; t += 2000; return JSON.stringify({ keep: [1], asked: 1, points: ['요금'], holds: {}, search: '청풍 케이블카 요금표' }) }) }).run({ query: 'q' }, { task: ask })
      return { queries: s.queries, calls }
    }
    expect(await run(2000)).toEqual({ queries: ['q'], calls: 0 })
    expect(await run(3100)).toEqual({ queries: ['q'], calls: 0 })
  })
  it('"멈춰" while two pages open: it returns at once, nothing is judged or searched', async () => {
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
    expect(calls).toBe(0)
    expect(s.queries).toEqual(['q'])
    expect(out).not.toContain('opened and read')
  })
})

describe('c18a rule 3: a first-hand read is the helper\'s evidence', () => {
  const at = new Date().toISOString()
  const helper = (topic: string, said: string, extra: Partial<TeamMember>): TeamMember => ({ id: topic, parentId: null, depth: 1, role: `${topic} 조사`, topic, brief: `${topic} 케이블카 요금`, lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said, said, ...extra })
  it('(c19a) a fact on a page it read stands; a fact on a row it was shown stands too: its own cited sentence, never a host label', () => {
    const parts = helperParts([
      helper('제천', '제천 청풍 케이블카는 어른 왕복 1만 8천 원이에요 [청풍](https://cable.example/jc)', { shown: ['https://search.example/?q=x'], sources: ['https://cable.example/jc', 'https://search.example/?q=x'] }),
      helper('밀양', '밀양 얼음골 케이블카는 왕복 1만 6천 원이에요 [검색 결과](https://news.example/my)', { shown: ['https://news.example/my', 'https://search.example/?q=y'], sources: ['https://search.example/?q=y'] }),
      helper('여주', '여주 케이블카는 왕복 1만 5천 원이에요 [여주](https://cable.example/yj)', { shown: [], sources: ['https://cable.example/yj'] }),
    ])
    expect(parts[0]!.data!.facts.map(f => f.text).join(' ')).toBe('제천 청풍 케이블카는 어른 왕복 1만 8천 원이에요')
    expect(parts[1]!.data!.facts.map(f => [f.text, f.url])).toEqual([['밀양 얼음골 케이블카는 왕복 1만 6천 원이에요', 'https://news.example/my']])
    expect(parts[2]!.data!.facts[0]!.text).not.toContain('못 찾았어요')
  })
})

describe('c18a r2 #1 (c19a): no host test of units or whole sentences; the rows reach the reader whole', () => {
  it('rows with a percentage and a price, a weight change and a weight, reach the reader as they are', async () => {
    const { calls, out } = await unjudged('생수 2L 값 얼마야', [{ title: '생수값 소식', text: '생수값 소식 — 생수 2L 값이 3% 올라 1,250원이 됐다' }, { title: '신형 노트북', text: '신형 노트북 — 전작보다 15% 가벼워졌다' }, { title: '신형 노트북', text: '신형 노트북 — 무게 1.2 kg' }, { title: '세종 날씨', text: '세종 날씨 — 오후 흐림' }])
    expect(calls).toBe(0)
    for (const words of ['생수 2L 값이 3% 올라 1,250원이 됐다', '전작보다 15% 가벼워졌다', '무게 1.2 kg', '오후 흐림']) expect(out).toContain(words)
  })
  it('a "not done" sentence and a done one reach the reader whole; which is a signing is its call', async () => {
    const { out } = await unjudged('센터백 영입 소식', [{ title: '수원, 센터백 영입 협상', text: '수원, 센터백 영입 협상 — 수원이 센터백 영입 협상을 진행 중이지만 아직 계약하지 않았다' }, { title: '수원, 센터백 영입', text: '수원, 센터백 영입 — 수원이 센터백 박도현을 영입했다고 2일 밝혔다. 계약 기간은 3년이다' }])
    expect(out).toContain('아직 계약하지 않았다')
    expect(out).toContain('박도현을 영입했다고 2일 밝혔다')
  })
  it('the judge is no longer asked for quotes: its holds are not read, whatever it says', async () => {
    const prompts: string[] = []
    const items = [{ title: '생수값 소식', text: '생수값 소식 — 생수 2L 값이 3% 올라 1,250원이 됐다' }, { title: '수원, 센터백 영입 협상', text: '수원, 센터백 영입 협상 — 수원이 센터백 영입 협상을 진행 중이지만 아직 계약하지 않았다' }]
    const verdict = await judgedItems('생수 2L 값 얼마야', items, async p => { prompts.push(p); return JSON.stringify({ keep: [1], points: ['생수 2L 가격: 원화 금액 (원)'], holds: { 1: { '생수 2L 가격': '3% 올라' } } }) })
    expect(prompts[0]).not.toContain('In "holds"')
    expect(verdict).not.toHaveProperty('holds')
    const kinds = await judgedItems('센터백 영입 소식 2개', items, async () => JSON.stringify({ keep: [2], points: [], kind: '구단이 선수를 영입했다는 보도', holds: { 2: { kind: '센터백 영입 협상' } } }))
    expect(kinds).not.toHaveProperty('holds')
    expect(kinds?.keep).toEqual([2])
  })
})

describe('c18a r2 #2 (c19a): a page\'s fact is the helper\'s own sentence; the host adds no judge quote to it', () => {
  const at = new Date().toISOString()
  const member = (said: string, shown: string[]): TeamMember => ({ id: 'h', parentId: null, depth: 1, role: '조사', topic: '에어북', brief: '에어북 무게와 화면 크기', lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 's', hiredAt: at, result: said, said, shown, sources: ['https://maker.example/air'] })
  it('a point the helper\'s words leave out is not added from a judge quote; its own sentence keeps the page\'s name', () => {
    const [part] = helperParts([member('에어북 무게는 980g이에요. [메이커](https://maker.example/air)', ['https://maker.example/air'])])
    expect(part!.data!.facts.map(f => f.text)).toEqual(['에어북 무게는 980g이에요.'])
    expect(part!.data!.facts.every(f => f.site === '메이커')).toBe(true)
  })
  it('a point the helper\'s words already state is not repeated', () => {
    const [part] = helperParts([member('에어북 무게는 980g, 화면 크기는 13.6인치예요. [메이커](https://maker.example/air)', ['https://maker.example/air'])])
    expect(part!.data!.facts).toHaveLength(1)
  })
})

describe('c18a r3 (c19a): no blind read runs; the judge\'s quotes are never read or sent anywhere', () => {
  const reader = (meaning: Record<string, boolean>, seen: string[] = []) => async (prompt: string): Promise<string> => {
    seen.push(prompt)
    const entries = JSON.parse(prompt.split('\nEntries: ')[1]!) as { n: number; words: string }[]
    return JSON.stringify({ states: entries.filter(e => meaning[e.words]).map(e => e.n) })
  }
  const model = (verdict: () => string, meaning: Record<string, boolean>, seen: string[] = []) => async (p: string): Promise<string> => p.includes(STATED_PROMPT) ? reader(meaning, seen)(p) : verdict()

  it('the reviewer\'s price: "4%가량 하락" is never made a price by the host, because no quote is read at all', async () => {
    const items = [{ title: '주가 소식', text: '주가 소식 — 주가는 4%가량 하락했다' }]
    const seen: string[] = []
    const v = await judgedItems('주가 얼마야', items, model(() => JSON.stringify({ keep: [1], points: ['주가: 원화 금액'], holds: { 1: { 주가: '4%가량 하락' } } }), { '4%가량 하락': false }, seen))
    expect(seen).toHaveLength(0)
    expect(v).not.toHaveProperty('holds')
    expect(v).not.toHaveProperty('quotes')
  })
  it('the reviewer\'s kind: the judge\'s kind quote is not read; no blind read runs', async () => {
    const items = [{ title: '투자 유치 추진', text: '투자 유치 추진 — 로봇랩이 투자 유치를 추진 중이며 아직 투자를 받지 못했다' }]
    const quote = '로봇랩이 투자 유치를 추진 중이며 아직 투자를 받지 못했다'
    const seen: string[] = []
    const v = await judgedItems('스타트업 투자 뉴스 3개', items, model(() => JSON.stringify({ keep: [1], points: [], kind: '스타트업이 투자를 받았다는 보도', holds: { 1: { kind: quote } } }), { [quote]: false }, seen))
    expect(seen).toHaveLength(0)
    expect(v).not.toHaveProperty('holds')
  })
  it('new wordings: fares and signings go through judgedItems with no blind read and no holds', async () => {
    const seen: string[] = []
    const items = [
      { title: '광역버스 요금 조정', text: '광역버스 요금 조정 — 광역버스 기본요금이 12% 오른다' },
      { title: '광역버스 요금표', text: '광역버스 요금표 — 광역버스 기본요금은 3,000원이다' },
      { title: '수원, 윙어 영입 근접', text: '수원, 윙어 영입 근접 — 수원이 윙어 김하람과 협상 중이나 아직 서명하지 않았다' },
      { title: '대전, 윙어 영입', text: '대전, 윙어 영입 — 대전이 윙어 이도윤을 영입했다고 5일 밝혔다' },
    ]
    const meaning = { '기본요금이 12% 오른다': false, '기본요금은 3,000원이다': true, '수원이 윙어 김하람과 협상 중이나 아직 서명하지 않았다': false, '대전이 윙어 이도윤을 영입했다고 5일 밝혔다': true }
    const fare = await judgedItems('광역버스 요금 얼마야', items.slice(0, 2), model(() => JSON.stringify({ keep: [1, 2], points: ['광역버스 요금: 원화 금액'], holds: { 1: { '광역버스 요금': '기본요금이 12% 오른다' }, 2: { '광역버스 요금': '기본요금은 3,000원이다' } } }), meaning, seen))
    expect(fare).not.toHaveProperty('holds')
    expect(fare?.keep).toEqual([1, 2])
    const signings = await judgedItems('K리그 영입 소식 2개', items.slice(2), model(() => JSON.stringify({ keep: [1, 2], points: [], kind: '구단이 선수를 영입했다는 보도', holds: { 1: { kind: '수원이 윙어 김하람과 협상 중이나 아직 서명하지 않았다' }, 2: { kind: '대전이 윙어 이도윤을 영입했다고 5일 밝혔다' } } }), meaning, seen))
    expect(signings).not.toHaveProperty('holds')
    expect(seen).toHaveLength(0)
  })
  it('whatever the model would answer to a blind read, judgedItems never asks for one', async () => {
    const seen: string[] = []
    const v = await judgedItems('요금 얼마야', [{ text: '요금표 — 기본요금은 3,000원이다' }], async p => { seen.push(p); return p.includes(STATED_PROMPT) ? 'sorry' : JSON.stringify({ keep: [1], points: ['요금: 원화 금액'], holds: { 1: { 요금: '기본요금은 3,000원이다' } } }) })
    expect(seen).toHaveLength(1)
    expect(v).not.toHaveProperty('holds')
    expect(v?.keep).toEqual([1])
    seen.length = 0
    await judgedItems('요금 얼마야', [{ text: '요금표 — 기본요금은 3,000원이다' }], async p => { seen.push(p); return JSON.stringify({ keep: [1], points: ['요금: 원화 금액'], holds: { 1: { 요금: '4,000원' } } }) })
    expect(seen.filter(p => p.includes(STATED_PROMPT))).toHaveLength(0)
  })
  it('a page opened right after the search: its "not yet" sentence reaches the reader as written; nothing is judged or read blind', async () => {
    const ask = '세종 신규 노선 개통일 알려줘', headline = row('https://news.example/sj', '세종 신규 버스 노선')
    const quote = '신규 노선은 아직 개통일이 정해지지 않았다'
    const s = search([page('q', [headline])]), seen: string[] = []
    const out = await checkedSearch(s, {
      ask: () => ask, since: 0, now: () => 0,
      write: model(() => JSON.stringify({ keep: [1], asked: 1, points: ['개통일: 날짜'], open: 1, holds: { 1: { 개통일: quote } }, search: '' }), { [quote]: false }, seen),
      read: async () => `세종 신규 버스 노선\n${quote}. 시는 연내 발표할 계획이다.`,
    }).run({ query: 'q' }, { task: ask })
    expect(seen).toHaveLength(0)
    expect(out).toContain(`${quote}. 시는 연내 발표할 계획이다.`)
    expect(out).not.toContain('못 찾았어요')
  })
})
