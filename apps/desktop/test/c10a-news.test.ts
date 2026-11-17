import { expect, test, vi } from 'vitest'
import { cometTools, type HarnessMetric } from 'core'
import { checked } from './checked-rows.js'

const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘'
const article = (title: string, url: string, date: string) => [{ text: title, url }, { text: date, url }]
const body = (rows: { text: string }[]) => rows.map(row => row.text).join('\n').padEnd(500, ' .')
// The first pass as the stack-9 run saw it: one round (메디인테크) and a statistic in the month, nothing more over the year.
const period = [...article('메디인테크, 338억 원 규모 시리즈C 투자 유치', 'https://www.asiae.co.kr/1', '1일 전'), ...article('올해 1~3분기 국내 벤처투자 12조6248억 원 역대 최대', 'https://news.mt.co.kr/2', '1일 전')]
const quarter = [...article('리벨리온, AI 반도체 620억 원 투자 유치', 'https://www.hankyung.com/3', '2026.09.20.'), ...article('퓨리오사AI, 시리즈D 800억 원 유치', 'https://www.etnews.com/4', '2026.10.01.')]
const roundUpList = article('스타트업 투자 동향 주간 리포트 11월 셋째 주', 'https://platum.kr/weekly/47', '2일 전')
const roundUpPage = {
  url: 'https://platum.kr/weekly/47',
  text: ['11월 셋째 주 스타트업 투자 동향', '▲ 업스테이지, AI 문서 인식으로 1500억 원 시리즈C 투자 유치 (11월 13일)', '▲ 뤼튼, AI 에이전트 플랫폼 300억 원 투자 유치', '▲ 마키나락스, 산업용 AI 200억 원 시리즈C 유치 (11월 12일)', '▲ 푸드테크 키친랩, 50억 원 시리즈A 유치', '이번 주 투자 건수는 21건이에요.'].join('\n'),
  links: [{ text: '업스테이지, AI 문서 인식으로 1500억 원 시리즈C 투자 유치', url: 'https://platum.kr/archives/1' }, { text: '플래텀 홈', url: 'https://platum.kr/' }],
}
function courier(second: boolean) {
  const asked: string[] = []
  const fetchPage = async (url: string) => {
    asked.push(url)
    if (url === roundUpPage.url) return roundUpPage
    const params = new URL(url).searchParams, query = params.get('query') ?? '', nso = params.get('nso') ?? ''
    const rows = !second ? (/p:1m/.test(nso) && !/시리즈/.test(query) ? period : []) : /주간 리포트/.test(query) ? roundUpList : /p:3m/.test(nso) ? quarter : /p:1y/.test(nso) ? [] : period
    return { url, text: body(rows), links: rows }
  }
  return { asked, fetchPage }
}
async function search(second: boolean) {
  const { asked, fetchPage } = courier(second), metrics: HarnessMetric[] = []
  const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage } as never, onMetric: metric => { metrics.push(metric) } }).find(one => one.name === 'search_web')!
  const out = await tool.run({ query: '국내 AI 스타트업 투자 유치', kind: 'news' }, { task: ask, steps: [], read: '' } as never)
  return { out, asked, metrics }
}

// c11b: the second pass (three months, a round-up search and page) is gone: the search hands over what the period and the year hold,
// c13b: and its rows are judged before the model writes (core checkedSearch); a short list is said to the model as data, with no extra round.
test('c10a R3 (c13b): a counted ask loads the period page and the year page only; both period rows reach the check; the count is logged; the statistic never reaches the model', async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  try {
    const { out, asked, metrics } = await search(true)
    expect(asked).toHaveLength(2)
    expect(asked.some(url => /p:3m/.test(url) || url === roundUpPage.url || /주간 리포트/.test(new URL(url).searchParams.get('query') ?? ''))).toBe(false)
    const rows = out.split('\n').filter(line => line.startsWith('- '))
    expect(rows.map(row => / — (https?:\S+)/.exec(row)![1]).sort()).toEqual(['https://news.mt.co.kr/2', 'https://www.asiae.co.kr/1'])
    expect(out).toContain('They asked for 5')
    expect(out).not.toMatch(/Background only|The rows that are the event asked for/)
    const passes = metrics.filter(metric => metric.operation === 'news-pass').map(metric => metric.counts)
    expect(passes).toEqual([{ pass: 1, recent: 2, older: 0, kept: 2 }])
    const round = rows.findIndex(row => row.includes('https://www.asiae.co.kr/1')) + 1
    const judged = await checked(out, ask, `{"keep":[${round}],"same":[],"listing":[${3 - round}],"outside":[]}`, { now: 20_000 })
    expect(judged.rows).toEqual(['https://www.asiae.co.kr/1'])
    expect(judged.out).toContain('1 of the 5 asked for were found')
    expect(judged.out).not.toContain('They asked for 5: list')
  } finally { vi.useRealTimers() }
})

test('c10a R3 (c13b): with nothing more to find, the host writes no count lead: the model is told the count as data, before it writes', async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  try {
    const { out, asked } = await search(false)
    expect(asked.length).toBeLessThanOrEqual(2)
    expect(out).toContain('https://news.mt.co.kr/2')
    const judged = await checked(out, ask, '{"keep":[1,2],"same":[],"listing":[],"outside":[],"search":"AI 스타트업 시리즈 투자"}', { now: 20_000 })
    const data = judged.out.split('\n').find(line => line.startsWith('These rows were checked'))!
    expect(data).toContain('2 of the 5 asked for were found')
    expect(data).not.toMatch(/확실한|[가-힣]/)
    // Too late for a widened search: none ran.
    expect(judged.queries).toEqual(['q'])
  } finally { vi.useRealTimers() }
})

test('c10a R3/H6 (c13b): the run\'s statistic row is judged a listing and never reaches the model, so neither answer could list it', async () => {
  const none = ['results for "국내 AI 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):',
    '- 올해 1~3분기 국내 벤처투자 12조6248억 원 — https://news.mt.co.kr/2 — x — 11월 17일'].join('\n')
  const now = new Date(2026, 10, 17, 9, 30)
  const r3 = ['딱 맞는 소식은 아직 없어서, 가까운 소식만 모았어요.', '', '메디인테크, 로봇내시경 AI 기술 기반으로 338억 원 규모 시리즈C 투자 유치 (11월 17일) — [아시아경제](https://www.asiae.co.kr/1)', '올해 1~3분기 국내 벤처투자 12조 6248억 원으로 역대 최대, AI·반도체 분야 대형 투자가 견인 (11월 17일) — [머니투데이](https://news.mt.co.kr/2)'].join('\n')
  expect(r3).toContain('https://news.mt.co.kr/2')
  expect(now.getFullYear()).toBe(2026)
  const h6Ask = '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘'
  const h6 = '메디인테크가 로봇내시경 기술 기반으로 338억 원 규모 시리즈C 투자를 유치했어요. 11월 17일 [이데일리](https://www.edaily.co.kr/1)\n\n국내 벤처투자가 역대 최대래요. [머니투데이](https://news.mt.co.kr/2)'
  expect(h6).toContain('https://news.mt.co.kr/2')
  for (const one of [ask, h6Ask]) {
    const judged = await checked(none, one, '{"keep":[1],"same":[],"listing":[1],"outside":[]}')
    expect(judged.rows).toEqual([])
    expect(judged.out).not.toContain('벤처투자')
  }
})

test('c10a R3 (c13b): a plan word in a headline is the quick model\'s to weigh, never the host\'s: four rows it keeps all reach the model', async () => {
  const titles = ['메디인테크, 338억 원 시리즈C 유치…해외 진출 추진', '뤼튼, 시리즈B 투자 유치 추진', '업스테이지, 500억 투자 검토', '정부, 기업가치 1조 AI 스타트업 20곳 육성']
  const answer = titles.map((title, i) => `${i + 1}. ${title} — 11월 1${i}일 [기사](https://example.com/n${i})`).join('\n')
  const page = ['results for "AI 스타트업 투자" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):', ...answer.split('\n').map(line => `- ${line.replace(/^\d\. /, '').replace(/ — (11월 \d+일) \[기사\]\((\S+)\)$/, ' — $2 — x — $1')}`)].join('\n')
  const judged = await checked(page, '요즘 AI 스타트업 투자 뉴스 4개', '{"keep":[1,2,3,4],"same":[],"listing":[],"outside":[]}')
  expect(judged.rows).toEqual(['https://example.com/n0', 'https://example.com/n1', 'https://example.com/n2', 'https://example.com/n3'])
  expect(judged.out).toContain('They hold the 4 asked for')
})

// c10a r2 (Codex r1): a weekly round-up's own date is no article's date. Wordings not in the harness. c11b: the host reads no round-up.
// c13b: a round-up row is a listing to the verdict, and a row with no day of its own is one the ask cannot use (lists): neither is shown.
test('c10a r2 (c13b): a round-up row and a row without its own day never reach the model; an item dated in its own words does', async () => {
  const page = ['results for "AI 스타트업 투자" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):', '- [2026.11.10] 클로바랩, 생성형 AI 검색으로 200억 원 시리즈B 투자 유치 — https://example.kr/a/1 — x', '- 딥노트, AI 회의록 서비스 90억 원 프리A 투자 유치 — https://example.kr/a/2 — x', '- 11월 둘째 주 스타트업 투자 동향 — https://example.kr/weekly — x — 11월 14일'].join('\n')
  const judged = await checked(page, 'AI 스타트업 투자 뉴스 4건 알려줘', '{"keep":[1,2,3],"same":[],"lists":[2,3],"listing":[3],"outside":[]}')
  expect(judged.rows).toEqual(['https://example.kr/a/1'])
  expect(judged.out).toContain('1 of the 4 asked for were found')
})

// c10a r3 (Codex r2): nothing dated an undated round as recent but inPeriod. Any source, any wording: a round with no date is no counted item.
test('c10a r3 (c13b): an undated round still reaches the check, after the dated one; the verdict that it lacks a day keeps it from the model', async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  try {
    const asked2 = '바이오 스타트업 투자 유치 소식 두 건만 링크 달아서 알려줘'
    const rows = [...article('지놈랩, 신약 플랫폼으로 120억 원 시리즈B 투자 유치', 'https://www.example-news.kr/a', '3일 전'), { text: '하모니셀, 세포치료제 80억 원 투자 유치', url: 'https://www.other-daily.kr/b' }]
    // The undated round stands far from any date on the page, as a row whose date the page never printed.
    const text = ['지놈랩, 신약 플랫폼으로 120억 원 시리즈B 투자 유치', '3일 전', ' .'.repeat(200), '하모니셀, 세포치료제 80억 원 투자 유치', ' .'.repeat(200)].join('\n')
    const fetchPage = async (url: string) => ({ url, text, links: rows })
    const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage } as never }).find(one => one.name === 'search_web')!
    const out = await tool.run({ query: '바이오 스타트업 투자 유치', kind: 'news' }, { task: asked2, steps: [], read: '' } as never)
    const items = out.split('\n').filter(line => line.startsWith('- '))
    expect(items).toHaveLength(2)
    expect(items[0]).toMatch(/^- 지놈랩.* — 11월 14일/)
    expect(items[1]).toMatch(/^- 하모니셀/)
    const answer = '1. 지놈랩이 120억 원을 유치했어요. [예시뉴스](https://www.example-news.kr/a)\n2. 하모니셀이 80억 원을 유치했어요. [다른일보](https://www.other-daily.kr/b)'
    expect(answer).toContain('https://www.other-daily.kr/b')
    const judged = await checked(out, asked2, '{"keep":[1,2],"same":[],"lists":[2],"listing":[],"outside":[]}', { now: 20_000 })
    expect(judged.rows).toEqual(['https://www.example-news.kr/a'])
    expect(judged.out).toContain('1 of the 2 asked for were found')
  } finally { vi.useRealTimers() }
})
