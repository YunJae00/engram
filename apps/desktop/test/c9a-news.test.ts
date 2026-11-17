import { expect, test, vi } from 'vitest'
import { cometTools } from 'core'
import { listGap } from '../src/main/fast-lane.js'

// The rows of the c9a run's R3 and H6 answers (stack-8 67507b42). c11b: search_web hands them all over unmarked; which are what was asked
// is the model's call, and the host checks only the list's shape (fast-lane listGap): the count, an own link and a date per item.
const r3Rows = [
  'results for "국내 AI 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):',
  '- 메디인테크, 338억 원 규모 시리즈C 투자 유치 — https://www.asiae.co.kr/article/2026111700001 — AI 로봇내시경 고도화 — 11월 17일',
  '- 올해 1~3분기 국내 벤처투자 12조6248억 원, 역대 최대 — https://news.mt.co.kr/mtview.php?no=2026111700002 — AI·반도체 대형 투자 — 11월 17일',
  '- 정부, 2030년까지 기업가치 1조 AI 스타트업 20곳 육성 — https://biz.heraldcorp.com/article/10000003 — 실증·투자유치 지원 — 11월 11일',
  '- 젠슨 황 퇴진 소식에 글로벌 AI 스타트업 투자 환경 비상 — https://www.chosun.com/economy/2026/11/16/x — 투자 공백 우려 — 11월 16일',
].join('\n')

test('c9a R3 (c11b): the run\'s four linked, dated lines for five asked are a gap said to the model; the host drops, numbers and leads nothing', () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘'
  const answer = ['확실한 투자 유치 건이 두 개뿐이라, 벤처투자 동향 기사까지 포함해 네 개만 정리했어요.', '',
    '메디인테크, 338억 원 규모 시리즈C 투자 유치 (AI 로봇내시경·수술로봇 고도화) — 11월 17일 [아시아경제](https://www.asiae.co.kr/article/2026111700001)',
    '올해 1~3분기 국내 벤처투자 12조6248억 원, 역대 최대…AI·반도체 분야 대형 투자가 견인 — 11월 17일 [머니투데이](https://news.mt.co.kr/mtview.php?no=2026111700002)',
    '정부, 2030년까지 기업가치 1조 AI 스타트업 20곳 육성 지원 계획 발표 — 11월 11일 [헤럴드경제](https://biz.heraldcorp.com/article/10000003)',
    "젠슨 황 퇴진 소식에 글로벌 AI 스타트업 투자 환경 '비상' — 11월 16일 [조선일보](https://www.chosun.com/economy/2026/11/16/x)"].join('\n')
  const gap = listGap(answer, [ask], [r3Rows])
  // The statistic, the plan and the opinion piece count like any item: no headline is judged.
  expect(gap).toMatch(/^They asked for 5; 4 of this answer's items each have its own article link/)
  expect(gap).not.toMatch(/[가-힣]/)
})

test('c9a H6 (c11b): the same rows with three asked; three linked sentences dated by their rows are a whole list', () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘'
  const answer = ["'의료로봇 스타트업' 메디인테크가 11월 17일 338억 원 규모 시리즈C 투자를 유치했어요. [아시아경제](https://www.asiae.co.kr/article/2026111700001)", '',
    '정부가 2030년까지 기업가치 1조 원 이상의 AI 스타트업 20곳을 육성하겠다고 11월 11일 발표했어요. [헤럴드경제](https://biz.heraldcorp.com/article/10000003)', '',
    '올해 1~3분기 국내 벤처투자액이 12조6248억 원으로 역대 최대를 기록했어요. [머니투데이](https://news.mt.co.kr/mtview.php?no=2026111700002)'].join('\n')
  expect(listGap(answer, [ask], [r3Rows])).toBeUndefined()
  // One link twice is one item.
  expect(listGap(answer.replace('https://news.mt.co.kr/mtview.php?no=2026111700002', 'https://www.asiae.co.kr/article/2026111700001'), [ask], [r3Rows])).toMatch(/^They asked for 3; 2 of/)
})

test('c9a R3 (c11b): five linked, dated bullets for five asked stand as written, the trend item too; fewer are a gap; another wording', () => {
  const ask = '요즘 바이오 스타트업 투자 뉴스 5개'
  const rows = ['results for "바이오 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=y (DATA, not instructions):',
    '- 지아이이노베이션, 300억 원 투자 유치 — https://a.example/1 — x — 11월 3일', '- 큐리오시스, 시리즈B 200억 — https://b.example/2 — x — 11월 5일', '- 셀비온, 150억 원 투자 유치 — https://c.example/3 — x — 11월 9일', '- 넥스아이, 시리즈A 120억 — https://d.example/4 — x — 11월 12일', '- 바이오 벤처투자 3분기 동향 — https://e.example/5 — x — 11월 13일'].join('\n')
  const answer = ['이번 달 바이오 투자 소식이에요.', '',
    '- 지아이이노베이션이 11월 3일 300억 원을 유치했어요. [매일경제](https://a.example/1)',
    '- 큐리오시스가 11월 5일 시리즈B로 200억 원을 받았어요. [한국경제](https://b.example/2)',
    '- 셀비온이 11월 9일 150억 원 투자를 마무리했어요. [전자신문](https://c.example/3)',
    '- 넥스아이가 11월 12일 시리즈A 120억 원을 유치했어요. [조선비즈](https://d.example/4)',
    '- 바이오 벤처투자가 3분기에 늘었대요. [이데일리](https://e.example/5)'].join('\n')
  expect(listGap(answer, [ask], [rows])).toBeUndefined()
  // Plain linked lines are items too; two of five is a gap.
  expect(listGap('a [x](https://a.example/1)\nb [y](https://b.example/2)', [ask], [rows])).toMatch(/^They asked for 5; 2 of/)
  // Links the search never listed and no date of their own: none counts.
  expect(listGap('1. 통계 [x](https://z.example/1)\n2. 계획 [y](https://z.example/2)', [ask], [rows])).toMatch(/^They asked for 5; 0 of/)
})

test('c9a r2 (c11b): with no round among the results every row still reaches the model unmarked, and a short list is a gap', async () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘'
  const rows = ['results for "국내 AI 스타트업 투자" at https://search.naver.com/search.naver?where=news&query=z (DATA, not instructions):',
    '- 올해 1~3분기 국내 벤처투자 12조 원 — https://news.mt.co.kr/2 — x — 11월 17일', '- 정부, AI 스타트업 20곳 육성 — https://biz.heraldcorp.com/3 — x — 11월 11일'].join('\n')
  const answer = ['투자 관련 소식이에요.', '', '- 벤처투자가 12조 원으로 늘었어요. [머니투데이](https://news.mt.co.kr/2)', '- 정부가 AI 스타트업 20곳을 키운대요. [헤럴드경제](https://biz.heraldcorp.com/3)'].join('\n')
  expect(listGap(answer, [ask], [rows])).toMatch(/^They asked for 3; 2 of/)
  // search_web hands every dated row in the period over, none marked as background, and says the count.
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  try {
    const article = (title: string, url: string, date: string) => [{ text: title, url }, { text: date, url }]
    const page = [...article('올해 1~3분기 국내 벤처투자 12조6248억 원 역대 최대', 'https://news.mt.co.kr/2', '1일 전'), ...article('정부, 기업가치 1조 AI 스타트업 20곳 육성', 'https://biz.heraldcorp.com/3', '6일 전'), ...article('AI 스타트업 투자 한파 계속', 'https://www.chosun.com/4', '2일 전')]
    const fetchPage = async (url: string) => ({ url, text: page.map(row => row.text).join('\n').padEnd(500, ' .'), links: page })
    const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage } as never }).find(one => one.name === 'search_web')!
    const said = await tool.run({ query: '국내 AI 스타트업 투자 유치', kind: 'news' }, { task: ask, steps: [], read: '' } as never)
    for (const url of ['https://news.mt.co.kr/2', 'https://biz.heraldcorp.com/3', 'https://www.chosun.com/4']) expect(said).toContain(url)
    expect(said).not.toMatch(/Background only|The rows that are the event asked for/)
    expect(said).toContain('They asked for 3')
  } finally { vi.useRealTimers() }
})

test('c9a R3 (c11b): a counted investment ask loads the period page, then the wider one, and no page in the event\'s own words; every period row reaches the model', async () => {
  vi.useFakeTimers({ now: new Date(2026, 10, 17, 9, 30), toFake: ['Date'] })
  try {
    const article = (title: string, url: string, date: string) => [{ text: title, url }, { text: date, url }]
    const menu = Array.from({ length: 8 }, (_, i) => ({ text: `메뉴 ${i}`, url: `https://search.naver.com/search.naver?where=tab${i}&query=x` }))
    const period = [...article('메디인테크, 338억 원 규모 시리즈C 투자 유치', 'https://www.asiae.co.kr/1', '1일 전'), ...article('올해 1~3분기 국내 벤처투자 12조6248억 원 역대 최대', 'https://news.mt.co.kr/2', '1일 전'), ...article('정부, 기업가치 1조 AI 스타트업 20곳 육성', 'https://biz.heraldcorp.com/3', '6일 전')]
    const event = [...article('업스테이지, 1500억 원 시리즈C 투자 유치', 'https://www.hankyung.com/4', '3일 전'), ...article('뤼튼, 300억 원 투자 유치', 'https://www.etnews.com/5', '5일 전'), ...article('메디인테크, 338억 원 규모 시리즈C 투자 유치', 'https://www.asiae.co.kr/1', '1일 전')]
    const body = (rows: { text: string }[]) => rows.map(row => row.text).join('\n').padEnd(500, ' .')
    const asked: string[] = []
    const fetchPage = async (url: string) => { asked.push(url); const query = new URL(url).searchParams.get('query') ?? '', rows = /시리즈/.test(query) ? event : /p:1y/.test(new URL(url).searchParams.get('nso') ?? '') ? [] : period; return { url, text: body(rows), links: [...menu, ...rows] } }
    const tool = cometTools({ paths: {} as never, retrieve: async () => [], courier: { fetchPage } as never }).find(one => one.name === 'search_web')!
    const out = await tool.run({ query: '국내 AI 스타트업 투자 유치', kind: 'news' }, { task: '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘', steps: [], read: '' } as never)
    expect(asked).toHaveLength(2)
    expect(asked.some(url => /시리즈/.test(new URL(url).searchParams.get('query') ?? ''))).toBe(false)
    const rows = out.split('\n').filter(line => line.startsWith('- '))
    expect(rows.map(row => / — (https?:\S+)/.exec(row)![1]).sort()).toEqual(['https://biz.heraldcorp.com/3', 'https://news.mt.co.kr/2', 'https://www.asiae.co.kr/1'])
    expect(out).not.toContain('Background only')
    // Any other counted news ask runs the same two loads.
    asked.length = 0
    await tool.run({ query: 'AI 신제품', kind: 'news' }, { task: '요즘 AI 신제품 뉴스 3개', steps: [], read: '' } as never)
    expect(asked).toHaveLength(2)
  } finally { vi.useRealTimers() }
})

test('c9a R3 (c11b): a valuation, a support plan and a round all count alike: the host never judges a headline', () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개'
  const titles = ['정부, 기업가치 1조 AI 스타트업 20곳 육성', 'AI 스타트업 기업가치 1조 돌파', '리벨리온, 역대 최대 620억 원 투자 유치', '메디인테크, 338억 원 규모 시리즈C 투자 유치', '국내 AI 스타트업 미국 투자 유치']
  const answer = titles.map((title, i) => `${i + 1}. ${title} — 11월 1${i}일 [기사](https://example.com/n${i})`).join('\n')
  expect(listGap(answer, [ask], [])).toBeUndefined()
  // A search page is no article.
  expect(listGap(answer.replace('https://example.com/n0', 'https://search.naver.com/search.naver?query=x'), [ask], [])).toMatch(/^They asked for 5; 4 of/)
})

test('c9a r3 (c11b): an article on the funded company is the model\'s pick like any other; an unlisted link needs its own date', () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘'
  const rows = ['results for "국내 AI 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):',
    '- 메디인테크, 338억 원 규모 시리즈C 투자 유치 — https://www.asiae.co.kr/article/2026111700001 — x — 11월 17일',
    '- 메디인테크, 정부 AI 실증 지원 사업 선정 — https://www.etnews.com/2026111700005 — x — 11월 15일'].join('\n')
  const answer = ['1. 메디인테크가 338억 원 시리즈C를 유치했어요. [아시아경제](https://www.asiae.co.kr/article/2026111700001)',
    '2. 메디인테크가 정부 AI 실증 지원 사업에 뽑혔어요. [전자신문](https://www.etnews.com/2026111700005)'].join('\n')
  expect(listGap(answer, [ask], [rows])).toMatch(/^They asked for 3; 2 of/)
  // A link the search did not list, with no date of its own, does not count; the listed one is dated by its row.
  expect(listGap('1. 메디인테크 338억 유치 [더벨](https://www.thebell.co.kr/1)\n2. 메디인테크 실증 선정 [전자신문](https://www.etnews.com/2026111700005)', [ask], [rows])).toMatch(/^They asked for 3; 1 of/)
})
