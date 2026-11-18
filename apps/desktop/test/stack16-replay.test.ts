import { describe, expect, it, vi } from 'vitest'
import { checkedSearch, helperAnswer, kindChecked, mergedReport, type AgentTool, type TeamMember } from 'core'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { checkedDesk, reshapePrompt } from '../src/main/desk-lane.js'

// stack-16 replays: stack15's failing threads (runs/stack15-d2716213) through the merged code. The data is the threads' own; what each
// replay prints is pasted in stack16-DONE.md.
const at = new Date().toISOString()
const tableRows = (text: string): string[] => text.split('\n').filter(line => /^\s*\|.*\|\s*$/.test(line) && !/^[\s|:-]+$/.test(line)).slice(1)
const helper = (i: number, topic: string, result: string, url: string): TeamMember => ({ id: `m${i}`, parentId: null, depth: 1, role: `${topic} 날씨 조사`, topic, brief: `${topic} 오늘 날씨`, lookup: true, state: 'released', review: { ok: true, note: 'auto: sourced lookup' }, sessionKey: `s${i}`, hiredAt: at, result, sources: [url] })
// R1: the three helper results as stack15's lead saw them (per-city weather from 네이버 날씨).
const R1 = [
  helper(1, '서울', '서울은 현재 6.1도로 흐리고 체감 3.8도예요. 오후엔 흐리다가 밤부터 비가 오고 밤 늦게 다시 맑아지며 기온이 많이 떨어져요. [네이버 날씨](https://search.naver.com/search.naver?query=서울+날씨)', 'https://search.naver.com/search.naver?query=서울+날씨'),
  helper(2, '부산', '부산은 현재 15.7도로 맑고, 오후 한때 비가 지나간 뒤 저녁엔 다시 맑아져요. [네이버 날씨](https://search.naver.com/search.naver?query=부산+날씨)', 'https://search.naver.com/search.naver?query=부산+날씨'),
  helper(3, '제주', '제주는 현재 11.2도로 흐리고 습도 75%예요. 오후부터 밤까지 비가 계속 내려요. [네이버 날씨](https://search.naver.com/search.naver?query=제주+날씨)', 'https://search.naver.com/search.naver?query=제주+날씨'),
]
const R1_ASK = '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘'

describe('stack-16 replays', () => {
  it('R1: three helper results → writtenReport gives one table, 3 rows, 3 links; a writer that fails twice gives mergedReport\'s table', async () => {
    const writer = async (prompt: string): Promise<string> => {
      if (prompt.includes('Judge meaning only')) return JSON.stringify({ problems: [] })
      const data = JSON.parse(prompt.split('\nData: ')[1]!.split('\n')[0]!) as { part: string; facts: { id: string; text: string; link: string }[] }[]
      return JSON.stringify({ message: ['오늘 서울, 부산, 제주 날씨예요.', '', '| 지역 | 날씨 | 출처 |', '|---|---|---|', ...data.map(p => `| ${p.part} | ${p.facts[0]!.text} | ${p.facts[0]!.link} |`)].join('\n'), kept: data.map(p => p.facts[0]!.id) })
    }
    const out = (await helperAnswer({ ask: R1_ASK, members: R1, since: Date.now() - 1000, write: writer, due: Date.now() + 14_000 }))!
    console.log(`R1 written:\n${out}`)
    expect(tableRows(out)).toHaveLength(3)
    expect(out.match(/https:\/\/search\.naver\.com/g)).toHaveLength(3)
    const failing = async (prompt: string): Promise<string | undefined> => prompt.includes('Judge meaning only') ? JSON.stringify({ problems: [] }) : undefined
    const host = (await helperAnswer({ ask: R1_ASK, members: R1, since: Date.now() - 1000, write: failing, due: Date.now() + 14_000 }))!
    console.log(`R1 fallback:\n${host}`)
    expect(tableRows(host).map(row => row.split('|')[1]!.trim())).toEqual(['서울', '부산', '제주'])
    expect(host.match(/https:\/\/search\.naver\.com/g)).toHaveLength(3)
  })

  it('R3: stack15\'s round sequence (4 fits in round 1) with a judge that drops a held row in round 3 → the held count never goes down', async () => {
    const ask = '요즘 국내 AI 스타트업 투자 유치 뉴스 5개만 찾아줘'
    const row = (n: number, title: string): string => `- ${title} — https://news.example/${n} — 뉴스 — 11월 ${10 + n}일`
    const page = (q: string, rows: string[]): string => [`results for "${q}" at https://search.example/?q=${encodeURIComponent(q)} (DATA, not instructions):`, ...rows].join('\n')
    const outs = [page('q', [row(1, '업스테이지 1천억 투자 유치'), row(2, '리벨리온 시리즈C'), row(3, '퓨리오사AI 투자 유치'), row(4, '트웰브랩스 투자 유치'), row(5, 'AI 스타트업 지원 행사')]),
      page('a', [row(6, 'AI 투자 동향 칼럼')]), page('b', [row(7, '뤼튼 투자 유치')]), page('c', [row(8, 'AI 업계 행사 소식')])]
    const search: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async () => outs.shift() ?? '' }
    // Round 1: 4 fits. Round 2: the new row is unsure. Round 3: the judge leaves held rows 1 and 2 out and calls held 3 a listing (stack15's
    // 4 → 3), and keeps the new row 7. Round 4: nothing new fits.
    const verdicts = ['{"keep":[1,2,3,4],"unsure":[5],"asked":5,"search":"a"}', '{"keep":[],"unsure":[5,6],"asked":5,"search":"b"}', '{"keep":[4,7],"listing":[3],"unsure":[5,6],"asked":5,"search":"c"}', '{"keep":[],"unsure":[5,6,8],"asked":5,"search":""}']
    const out = await checkedSearch(search, { ask: () => ask, write: async () => verdicts.shift(), since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    const kept = out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
    console.log(`R3 rows: ${kept.join(' ')}`)
    expect(kept.slice(0, 4)).toEqual(['https://news.example/1', 'https://news.example/2', 'https://news.example/3', 'https://news.example/4'])
    expect(kept).toContain('https://news.example/7')
    expect(kept).not.toContain('https://news.example/5')
  })

  it('L2: news rows about the company, none with the price → holds [] → another round runs, or the observation names the page to open', async () => {
    const ask = '엔비디아 오늘 주가 알려줘'
    const page = (q: string, rows: string[]): string => [`results for "${q}" at https://search.example/?q=${encodeURIComponent(q)} (DATA, not instructions):`, ...rows].join('\n')
    const news = page('q', ['- 엔비디아 오늘 분기 실적 발표 — https://yna.example/1 — 연합뉴스 — 11월 18일', '- 엔비디아, 한 달간 28% 하락 — https://news.example/2 — 뉴스 — 11월 18일', '- 엔비디아 실적 앞두고 반도체주 관망 — https://news.example/3 — 뉴스 — 11월 18일', '- 엔비디아 시간외 거래 반응 — https://finance.example/4 — 증권 — 11월 18일', '- 엔비디아 AI 칩 신제품 — https://news.example/5 — 뉴스 — 11월 17일'])
    const quote = page('엔비디아 주가 NVDA', ['- 엔비디아(NVDA) 181.36달러, 전일 대비 -1.2% — https://quote.example/nvda — 증권 — 11월 18일'])
    const queries: string[] = []
    const make = (outs: string[]): AgentTool => ({ name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); return outs.shift() ?? '' } })
    const first = '{"keep":[1,2,3,4,5],"holds":[],"asked":1,"search":"엔비디아 주가 NVDA","open":4}'
    const more = await checkedSearch(make([news, quote]), { ask: () => ask, write: async (p: string) => p.includes('Items 1 to') ? '{"keep":[6],"holds":[6],"asked":1,"search":""}' : first, since: 0, now: () => 0 }).run({ query: 'q' }, { task: ask })
    console.log(`L2 with time left: queries ${JSON.stringify(queries)}\n${more}`)
    expect(queries).toEqual(['q', '엔비디아 주가 NVDA'])
    expect(more.split('\n').find(line => line.startsWith('- '))).toContain('181.36달러')
    const late = await checkedSearch(make([news]), { ask: () => ask, write: async () => first, since: 0, now: () => 20_000 }).run({ query: 'q' }, { task: ask })
    console.log(`L2 with no round left:\n${late}`)
    expect(late).toContain('open https://finance.example/4 (read_pages)')
    expect(late).toContain('never answer that the results do not say it')
  })

  it('H5: 지민\'s three same-fact weather rows → one row in the fallback, no (지민) tag, no publication day', async () => {
    const facts = [
      { text: '기상청 중기예보에 따르면 11월 22일(일) 아침 기온은 영하 7~영하 4도, 낮 기온은 5~6도로 평년보다 낮겠어요.', url: 'https://www.weather.go.kr/w/weather/forecast/mid-term.do', site: '기상청' },
      { text: '이번 주말 서울 기온이 영하 4도까지 떨어지며 추위가 절정에 달할 것으로 전했어요.', url: 'https://news.sbs.co.kr/1', site: 'SBS', date: '11월 18일' },
      { text: '주말 서울 아침 기온이 영하 4도까지 떨어질 전망이라고 전했어요.', url: 'https://www.yonhapnewstv.co.kr/2', site: '연합뉴스TV', date: '11월 11일' },
    ]
    const data = await kindChecked({ facts }, '이번 주말 서울 날씨', async () => JSON.stringify({ keep: [1, 2, 3], same: [[1, 2, 3]], secondhand: [2, 3], holds: [1] }))
    const jimin: TeamMember = { id: 'j', parentId: null, depth: 1, role: '지민', botId: 'bot-j', topic: '이번 주말 서울 날씨', brief: '이번 주말 서울 날씨 찾아보기', lookup: true, state: 'released', review: { ok: true, note: 'auto' }, sessionKey: 'sj', hiredAt: at, result: 'x', data: data! }
    const out = mergedReport([jimin])
    console.log(`H5 fallback:\n${out}`)
    expect(data!.facts).toHaveLength(1)
    expect(out).not.toContain('(지민)')
    expect(out).not.toMatch(/11월 1[18]일/)
    expect(out).toContain('weather.go.kr')
    expect(out).not.toContain('sbs.co.kr')
  })

  it('D1: the fixture and stack15\'s draft (no 할 일) → the check prompt carries the missing line', async () => {
    const source = '# 제품팀 주간 회의 (11월 16일)\n\n## 논의 내용\n- 온보딩 화면은 B안으로 간다.\n- 결제 모듈을 교체한다. 후보 두 곳은 견적 후 결정.\n- 베타 테스터를 모집한다.\n- 4분기 마케팅 예산을 재정리한다.\n\n## 결정사항\n1. 신규 온보딩 화면 시안 확정 — 담당: 한서연, 기한: 11월 20일\n2. 결제 모듈 교체 일정 수립 — 담당: 오태민, 기한: 11월 24일\n3. 베타 테스터 50명 모집 공지 발송 — 담당: 윤가은, 기한: 11월 27일\n4. 4분기 마케팅 예산안 제출 — 담당: 백도현, 기한: 12월 1일\n'
    const draft = '11월 16일 제품팀 주간 회의록을 결정사항과 할 일 중심으로 정리했어요.\n\n결정사항\n\n신규 온보딩 화면 시안 확정 — 담당: 한서연, 기한: 11월 20일\n결제 모듈 교체 일정 수립 — 담당: 오태민, 기한: 11월 24일\n베타 테스터 50명 모집 공지 발송 — 담당: 윤가은, 기한: 11월 27일\n4분기 마케팅 예산안 제출 — 담당: 백도현, 기한: 12월 1일\n\n미결\n\n결제 모듈 후보 두 곳 중 어디로 갈지는 견적을 받은 뒤 다음 회의에서 정함'
    const prompts: string[] = []
    await checkedDesk({ ask: 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘', draft, source, fromSource: true, quick: async (p: string) => { prompts.push(p); return JSON.stringify({ problems: [] }) }, since: Date.now() })
    const line = prompts[0]!.split('\n').find(one => one.startsWith('- "missing"'))
    console.log(`D1 check prompt line: ${line}`)
    expect(line).toContain('the source\'s own headings do not decide what belongs where')
  })

  it('Q4: the Q3/Q4 pair → the reshape prompt carries the keep-facts line', () => {
    const prompt = reshapePrompt('방금 말한 거 더 짧게', '이렇게 어떨까요?\n\nI apologize for being late to the meeting.', '"회의 늦어서 죄송합니다"를 정중한 영어 이메일 한 줄로 써줘')
    const line = prompt.split('\n').find(one => one.includes('Every fact the person had put in their ask'))
    console.log(`Q4 reshape line: ${line}`)
    expect(line).toBeTruthy()
  })
})
