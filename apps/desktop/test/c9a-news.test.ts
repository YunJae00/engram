import { expect, test, vi } from 'vitest'
import { cometTools } from 'core'
import { checked } from './checked-rows.js'
// c11b r2: dates are read against the asked period on the day of the run.

// The rows of the c9a run's R3 and H6 answers (stack-8 67507b42). c13b: search_web hands them all over unmarked; which are what was asked
// is the quick model's call on the rows themselves (core checkedSearch), before the model writes: no headline is matched by a word list.
const r3Rows = [
  'results for "국내 AI 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):',
  '- 메디인테크, 338억 원 규모 시리즈C 투자 유치 — https://www.asiae.co.kr/article/2026111700001 — AI 로봇내시경 고도화 — 11월 17일',
  '- 올해 1~3분기 국내 벤처투자 12조6248억 원, 역대 최대 — https://news.mt.co.kr/mtview.php?no=2026111700002 — AI·반도체 대형 투자 — 11월 17일',
  '- 정부, 2030년까지 기업가치 1조 AI 스타트업 20곳 육성 — https://biz.heraldcorp.com/article/10000003 — 실증·투자유치 지원 — 11월 11일',
  '- 젠슨 황 퇴진 소식에 글로벌 AI 스타트업 투자 환경 비상 — https://www.chosun.com/economy/2026/11/16/x — 투자 공백 우려 — 11월 16일',
].join('\n')

test('c9a R3 (c13b): of the run\'s four rows for five asked, the verdict keeps the one round before the model writes; the count is data, in no Korean words', async () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘'
  const answer = ['확실한 투자 유치 건이 두 개뿐이라, 벤처투자 동향 기사까지 포함해 네 개만 정리했어요.', '',
    '메디인테크, 338억 원 규모 시리즈C 투자 유치 (AI 로봇내시경·수술로봇 고도화) — 11월 17일 [아시아경제](https://www.asiae.co.kr/article/2026111700001)',
    '올해 1~3분기 국내 벤처투자 12조6248억 원, 역대 최대…AI·반도체 분야 대형 투자가 견인 — 11월 17일 [머니투데이](https://news.mt.co.kr/mtview.php?no=2026111700002)',
    '정부, 2030년까지 기업가치 1조 AI 스타트업 20곳 육성 지원 계획 발표 — 11월 11일 [헤럴드경제](https://biz.heraldcorp.com/article/10000003)',
    "젠슨 황 퇴진 소식에 글로벌 AI 스타트업 투자 환경 '비상' — 11월 16일 [조선일보](https://www.chosun.com/economy/2026/11/16/x)"].join('\n')
  // The run's answer above was written from every row. Now the statistic, the plan and the opinion piece are judged by meaning first.
  expect(answer).toContain('벤처투자 12조6248억')
  const { out, rows, prompts } = await checked(r3Rows, ask, '{"keep":[1],"same":[],"listing":[],"outside":[],"search":""}')
  expect(rows).toEqual(['https://www.asiae.co.kr/article/2026111700001'])
  expect(prompts[0]).toContain('벤처투자 12조6248억')
  const data = out.split('\n').find(line => line.startsWith('These rows were checked'))!
  expect(data).toContain('Only 1 of the 5 asked for are here')
  expect(data).not.toMatch(/[가-힣]/)
})

test('c9a H6 (c13b): the same rows with three asked; the aggregate figure is a listing and does not reach the model, so its answer cannot list it', async () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘'
  const answer = ["'의료로봇 스타트업' 메디인테크가 11월 17일 338억 원 규모 시리즈C 투자를 유치했어요. [아시아경제](https://www.asiae.co.kr/article/2026111700001)", '',
    '정부가 2030년까지 기업가치 1조 원 이상의 AI 스타트업 20곳을 육성하겠다고 11월 11일 발표했어요. [헤럴드경제](https://biz.heraldcorp.com/article/10000003)', '',
    '올해 1~3분기 국내 벤처투자액이 12조6248억 원으로 역대 최대를 기록했어요. [머니투데이](https://news.mt.co.kr/mtview.php?no=2026111700002)'].join('\n')
  expect(answer).toContain('https://news.mt.co.kr/mtview.php?no=2026111700002')
  const { out, rows } = await checked(r3Rows, ask, '{"keep":[1,2,3],"same":[],"listing":[2],"outside":[]}')
  expect(rows).toEqual(['https://www.asiae.co.kr/article/2026111700001', 'https://biz.heraldcorp.com/article/10000003'])
  expect(out).not.toContain('벤처투자 12조6248억')
  expect(out).toContain('Only 2 of the 3 asked for are here')
})

test('c9a R3 (c13b): five rows for five asked that all fit reach the model whole; a trend row the verdict leaves out does not; another wording', async () => {
  const ask = '요즘 바이오 스타트업 투자 뉴스 5개'
  const rows = ['results for "바이오 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=y (DATA, not instructions):',
    '- 지아이이노베이션, 300억 원 투자 유치 — https://a.example/1 — x — 11월 3일', '- 큐리오시스, 시리즈B 200억 — https://b.example/2 — x — 11월 5일', '- 셀비온, 150억 원 투자 유치 — https://c.example/3 — x — 11월 9일', '- 넥스아이, 시리즈A 120억 — https://d.example/4 — x — 11월 12일', '- 바이오 벤처투자 3분기 동향 — https://e.example/5 — x — 11월 13일'].join('\n')
  const answer = ['이번 달 바이오 투자 소식이에요.', '',
    '- 지아이이노베이션이 11월 3일 300억 원을 유치했어요. [매일경제](https://a.example/1)',
    '- 큐리오시스가 11월 5일 시리즈B로 200억 원을 받았어요. [한국경제](https://b.example/2)',
    '- 셀비온이 11월 9일 150억 원 투자를 마무리했어요. [전자신문](https://c.example/3)',
    '- 넥스아이가 11월 12일 시리즈A 120억 원을 유치했어요. [조선비즈](https://d.example/4)',
    '- 바이오 벤처투자가 3분기에 늘었대요. [이데일리](https://e.example/5)'].join('\n')
  expect(answer.split('\n').filter(line => line.startsWith('- '))).toHaveLength(5)
  const all = await checked(rows, ask, '{"keep":[1,2,3,4,5],"same":[],"listing":[],"outside":[]}')
  expect(all.rows).toHaveLength(5)
  expect(all.out).toContain('They hold the 5 asked for: list 5 of them.')
  const four = await checked(rows, ask, '{"keep":[1,2,3,4],"same":[],"listing":[],"outside":[]}')
  expect(four.rows).not.toContain('https://e.example/5')
  expect(four.out).toContain('Only 4 of the 5 asked for are here')
  // A dead page goes too, whatever the verdict.
  expect((await checked(rows, ask, '{"keep":[1,2,3,4,5],"same":[],"listing":[],"outside":[]}', { dead: ['https://a.example/1'] })).rows).not.toContain('https://a.example/1')
})

test('c9a r2 (c13b): search_web still hands every row over unmarked; with no round among them the verdict leaves none, and the model is told so', async () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘'
  const rows = ['results for "국내 AI 스타트업 투자" at https://search.naver.com/search.naver?where=news&query=z (DATA, not instructions):',
    '- 올해 1~3분기 국내 벤처투자 12조 원 — https://news.mt.co.kr/2 — x — 11월 17일', '- 정부, AI 스타트업 20곳 육성 — https://biz.heraldcorp.com/3 — x — 11월 11일'].join('\n')
  const answer = ['투자 관련 소식이에요.', '', '- 벤처투자가 12조 원으로 늘었어요. [머니투데이](https://news.mt.co.kr/2)', '- 정부가 AI 스타트업 20곳을 키운대요. [헤럴드경제](https://biz.heraldcorp.com/3)'].join('\n')
  expect(answer).toContain('https://news.mt.co.kr/2')
  const none = await checked(rows, ask, '{"keep":[],"same":[],"listing":[],"outside":[],"search":""}')
  expect(none.rows).toEqual([])
  expect(none.out).toContain('None of the 3 asked for is here')
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

test('c9a R3 (c13b): which of a valuation, a support plan and a round fit is the quick model\'s verdict on the rows, never a host word list', async () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개'
  const titles = ['정부, 기업가치 1조 AI 스타트업 20곳 육성', 'AI 스타트업 기업가치 1조 돌파', '리벨리온, 역대 최대 620억 원 투자 유치', '메디인테크, 338억 원 규모 시리즈C 투자 유치', '국내 AI 스타트업 미국 투자 유치']
  const answer = titles.map((title, i) => `${i + 1}. ${title} — 11월 1${i}일 [기사](https://example.com/n${i})`).join('\n')
  const page = ['results for "AI 스타트업 투자" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):', ...titles.map((title, i) => `- ${title} — https://example.com/n${i} — x — 11월 1${i}일`)].join('\n')
  expect(answer.split('\n')).toHaveLength(5)
  // The host keeps what the verdict keeps, whatever the words: a verdict that keeps all five leaves all five.
  expect((await checked(page, ask, '{"keep":[1,2,3,4,5],"same":[],"listing":[],"outside":[]}')).rows).toHaveLength(5)
  const judged = await checked(page, ask, '{"keep":[3,4,5],"same":[],"listing":[],"outside":[]}')
  expect(judged.rows).toEqual(['https://example.com/n2', 'https://example.com/n3', 'https://example.com/n4'])
  expect(judged.prompts[0]).toContain(JSON.stringify(ask))
})

test('c9a r3 (c13b): an article on the funded company is kept or left by the verdict like any other row; a page that does not open is never shown', async () => {
  const ask = '요즘 국내 AI 스타트업 투자 뉴스 3개만 찾아줘'
  const rows = ['results for "국내 AI 스타트업 투자 유치" at https://search.naver.com/search.naver?where=news&query=x (DATA, not instructions):',
    '- 메디인테크, 338억 원 규모 시리즈C 투자 유치 — https://www.asiae.co.kr/article/2026111700001 — x — 11월 17일',
    '- 메디인테크, 정부 AI 실증 지원 사업 선정 — https://www.etnews.com/2026111700005 — x — 11월 15일'].join('\n')
  const answer = ['1. 메디인테크가 338억 원 시리즈C를 유치했어요. [아시아경제](https://www.asiae.co.kr/article/2026111700001)',
    '2. 메디인테크가 정부 AI 실증 지원 사업에 뽑혔어요. [전자신문](https://www.etnews.com/2026111700005)'].join('\n')
  expect(answer.split('\n')).toHaveLength(2)
  expect((await checked(rows, ask, '{"keep":[1,2],"same":[],"listing":[],"outside":[]}')).rows).toHaveLength(2)
  const dead = await checked(rows, ask, '{"keep":[1,2],"same":[],"listing":[],"outside":[]}', { dead: ['https://www.etnews.com/2026111700005'] })
  expect(dead.rows).toEqual(['https://www.asiae.co.kr/article/2026111700001'])
  expect(dead.out).toContain('Only 1 of the 3 asked for are here')
})
