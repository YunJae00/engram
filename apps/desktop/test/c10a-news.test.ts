import { expect, test, vi } from 'vitest'
import { cometTools, type HarnessMetric } from 'core'
import { listGap } from '../src/main/fast-lane.js'

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
// and a short list goes back to the model as a gap (fast-lane listGap) for one more round of its own.
test('c10a R3 (c11b): a counted ask loads the period page and the year page only; both period rows reach the model; the count is logged; a short answer is a gap', async () => {
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
    const answer = ['요즘 투자 소식이에요.', '', '1. 메디인테크가 11월 16일 338억 원 시리즈C를 유치했어요. [아시아경제](https://www.asiae.co.kr/1)', '2. 국내 벤처투자가 역대 최대예요. [머니투데이](https://news.mt.co.kr/2)'].join('\n')
    expect(listGap(answer, [ask], [out], new Date(2026, 10, 17, 9, 30))).toMatch(/^They asked for 5; 2 of/)
  } finally { vi.useRealTimers() }
})

test('c10a R3 (c11b): with nothing more to find, the host writes no count lead and drops nothing: the model gets the gap', async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  try {
    const { out, asked } = await search(false)
    expect(asked.length).toBeLessThanOrEqual(2)
    expect(out).toContain('https://news.mt.co.kr/2')
    const answer = ['딱 맞는 건 하나예요.', '', '1. 메디인테크가 338억 원 시리즈C를 유치했어요. [아시아경제](https://www.asiae.co.kr/1)', '2. 국내 벤처투자가 역대 최대예요. [머니투데이](https://news.mt.co.kr/2)'].join('\n')
    const gap = listGap(answer, [ask], [out], new Date(2026, 10, 17, 9, 30))
    expect(gap).toMatch(/^They asked for 5; 2 of/)
    expect(gap).not.toMatch(/확실한|[가-힣]/)
  } finally { vi.useRealTimers() }
})

test('c10a R3/H6 (c11b): the run\'s answers are short lists: each is a gap, an item dated by its own words or by its row counts', () => {
  const none = ['results for "국내 AI 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):',
    '- 올해 1~3분기 국내 벤처투자 12조6248억 원 — https://news.mt.co.kr/2 — x — 11월 17일'].join('\n')
  const now = new Date(2026, 10, 17, 9, 30)
  const r3 = ['딱 맞는 소식은 아직 없어서, 가까운 소식만 모았어요.', '', '메디인테크, 로봇내시경 AI 기술 기반으로 338억 원 규모 시리즈C 투자 유치 (11월 17일) — [아시아경제](https://www.asiae.co.kr/1)', '올해 1~3분기 국내 벤처투자 12조 6248억 원으로 역대 최대, AI·반도체 분야 대형 투자가 견인 (11월 17일) — [머니투데이](https://news.mt.co.kr/2)'].join('\n')
  expect(listGap(r3, [ask], [none], now)).toMatch(/^They asked for 5; 2 of/)
  const h6Ask = '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘'
  const h6 = '메디인테크가 로봇내시경 기술 기반으로 338억 원 규모 시리즈C 투자를 유치했어요. 11월 17일 [이데일리](https://www.edaily.co.kr/1)\n\n국내 벤처투자가 역대 최대래요. [머니투데이](https://news.mt.co.kr/2)'
  expect(listGap(h6, [h6Ask], [none], now)).toMatch(/^They asked for 3; 2 of/)
})

test('c10a R3 (c11b): a plan word in a headline is the model\'s to weigh; the host counts four linked, dated items for four asked', () => {
  const titles = ['메디인테크, 338억 원 시리즈C 유치…해외 진출 추진', '뤼튼, 시리즈B 투자 유치 추진', '업스테이지, 500억 투자 검토', '정부, 기업가치 1조 AI 스타트업 20곳 육성']
  const answer = titles.map((title, i) => `${i + 1}. ${title} — 11월 1${i}일 [기사](https://example.com/n${i})`).join('\n')
  expect(listGap(answer, ['요즘 AI 스타트업 투자 뉴스 4개'], [], new Date(2026, 10, 17, 9, 30))).toBeUndefined()
})

// c10a r2 (Codex r1): a weekly round-up's own date is no article's date. Wordings not in the harness. c11b: the host reads no round-up; an
// item on a page the search never listed is dated only by its own words.
test('c10a r2 (c11b): an item on an unlisted page counts only with a date of its own, inside the year', () => {
  const answer = ['1. [2026.11.10] 클로바랩, 생성형 AI 검색으로 200억 원 시리즈B 투자 유치 [플래텀](https://example.kr/a/1)', '2. 딥노트, AI 회의록 서비스 90억 원 프리A 투자 유치 [플래텀](https://example.kr/a/2)', '3. 뉴런웍스 AI 칩 설계로 450억 원 투자 유치 — 지난달 28일 [플래텀](https://example.kr/a/3)'].join('\n')
  expect(listGap(answer, ['AI 스타트업 투자 뉴스 4건 알려줘'], [], new Date(2026, 10, 17, 9, 30))).toMatch(/^They asked for 4; 1 of/)
})

// c10a r3 (Codex r2): nothing dated an undated round as recent but inPeriod. Any source, any wording: a round with no date is no counted item.
test('c10a r3 (c11b): an undated round still reaches the model, after the dated one; listed without a date it does not count', async () => {
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
    expect(listGap(answer, [asked2], [out], new Date(2026, 10, 17, 9, 30))).toMatch(/^They asked for 2; 1 of/)
  } finally { vi.useRealTimers() }
})
