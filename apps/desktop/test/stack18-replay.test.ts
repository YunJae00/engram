import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { createTask, handBacks, handoffBrief, keepRead, keepSources, listTasks, runToolSession, settleMember, skipWalls, timeBoxed, updateTask, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import * as desk from '../src/main/desk-lane.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/agent-voice.js'

const fns = (mod: object): string[] => Object.entries(mod).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const DESK_FNS = ['askNow', 'closingBuilds', 'deskKind', 'deskLane', 'deskLight', 'fileGiven', 'fixSlideTitle', 'isCorrection', 'keptFix', 'kindSortAsk', 'namedText', 'onlyTells', 'plainKeep', 'routeAsk', 'slideTitleFix', 'sortByKind']
const posted = async (draft: string, ask: string): Promise<string> => (await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }) } as never, workdir: '/x', tools: [] }, ask, {})).answer
const looking = (tool: AgentTool): AgentTool => timeBoxed(keepRead(keepSources(skipWalls(tool), new Set<string>()), []), () => 28_000)
const page = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const row = (url: string, title: string, snippet: string, day = '11월 18일'): string => `- ${title} — ${url} — ${snippet} — ${day}`
function search(outs: string[], tick?: () => void): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); tick?.(); return outs.shift() ?? page(String(args['query']), []) } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('T1 (stack17: 4 helpers all "found", the judge quotes paraphrased and rejected, 3 cities "못 찾았어요")', () => {
  type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const vault = async (): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, 'engram-s18-t1-')), '.engram') } as unknown as VaultPaths }
  const CITY: Record<string, { page: string; said: string }> = {
    서울: { page: '현재 7.2°C, 구름많음. 체감 4.9°C.', said: '서울은 지금 7.2도에 구름이 많아요' },
    부산: { page: '낮 최고 18°C, 온화함. 오늘 밤~내일 새벽까지 비.', said: '부산은 낮 최고 18도로 온화하고 밤부터 비가 와요' },
    제주: { page: '현재 16.1°C, 흐림. 바람 강함.', said: '제주는 16.1도에 흐려요' },
    대구: { page: '현재 9.4°C, 맑음.', said: '대구는 9.4도에 맑아요' },
  }
  const CITIES = Object.keys(CITY)
  const WEATHER = (city: string): string => `https://weather.example/${encodeURIComponent(city)}`
  it('T1: four helpers each say their city in their own words: all four reach the lead with their values, each search opens its top rows for the teammate as at base, nothing is judged, and no "못 찾았어요" is made for them', async () => {
    const paths = await vault(), ask = '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘 (대구도 추가)'
    const created = await createTask(paths, ask, 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1; t.team = { members: [], hires: 0, maxHires: 8, maxDepth: 3, big: true, approvedAt: new Date().toISOString() } })
    const opened: string[] = [], quick: string[] = []
    const city = (text: string): string => CITIES.find(one => text.includes(one)) ?? '서울'
    const searchTool: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
      const q = String(args['query']), at = city(q); await tick(20)
      return page(q, [row(WEATHER(at), `${at} 날씨`, CITY[at]!.page), row(`https://news.example/${encodeURIComponent(at)}`, `${at} 오늘 날씨 요약`, `${at} 지역 소식`)])
    } }
    const open: AgentTool = { name: 'open_page', description: '', argsSchema: {}, run: async args => { opened.push(String(args['url'])); return 'page "날씨"' } }
    const run: Run = async (deps, prompt, options = {}) => {
      options.onStart?.()
      const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', at = city(part)
      const tool = deps.tools?.find(t => t.name === 'search_web')
      const seen = tool ? await tool.run({ query: `${at} 오늘 날씨` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) }) : ''
      await tick(20)
      const said = seen.includes(CITY[at]!.page) ? CITY[at]!.said : `${at} 날씨는 못 찾았어요`
      return { answer: `${said}. [${at} 날씨](${WEATHER(at)})`, steps: [], fellBack: false }
    }
    const engine = { id: 'claude', quick: async (prompt: string) => { quick.push(prompt); return undefined } } as unknown as TurnKit['engine']
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), searchTool, open] }
    const hire = team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!
    const text = await hire.run({ members: CITIES.map(at => ({ role: `${at} 날씨 조사`, topic: at, brief: `${at} 오늘 날씨`, lookup: true })) }, { task: '' })
    const members = (await listTasks(paths))[0]!.team!.members.filter(m => m.lookup)
    console.log(`T1 replay: opened ${opened.length}\n${text}`)
    for (const at of CITIES) expect(opened).toContain(WEATHER(at))
    expect(opened).toHaveLength(2 * CITIES.length)
    expect(quick).toEqual([])
    for (const at of CITIES) expect(members.find(one => one.topic === at)!.result).toBe(`${CITY[at]!.said}. [${at} 날씨](${WEATHER(at)})`)
    expect((JSON.parse(text) as { members: { result: string }[] }).members.map(m => m.result)).toEqual(CITIES.map(at => `${CITY[at]!.said}. [${at} 날씨](${WEATHER(at)})`))
    for (const value of ['7.2도', '18도', '16.1도', '9.4도']) expect(text).toContain(value)
    expect(members.every(m => m.data === undefined)).toBe(true)
  }, 45_000)
})

describe('L1 (stack17: "오늘 서울 날씨 어때?" took 4 judge rounds, points=3, holds=0 on quotes split across title and snippet)', () => {
  it('L1: one point, the value split across title "서울 7.2°" and snippet "구름많음": the row reaches the model whole, with 0 judge calls and 1 search', async () => {
    const ask = '오늘 서울 날씨 어때?'
    const s = search([page('q', [row('https://weather.example/seoul', '서울 7.2°', '구름많음, 체감 4.9°'), row('https://news.example/seoul', '서울 11월 18일 오늘 날씨', '찬바람 강해져')])])
    const out = await looking(s).run({ query: 'q' }, { task: ask })
    console.log(`L1 replay: searches ${s.queries.join(' | ')}\n${out}`)
    expect(s.queries).toEqual(['q'])
    expect(urls(out)[0]).toBe('https://weather.example/seoul')
    expect(out).toContain('- 서울 7.2° — https://weather.example/seoul — 구름많음, 체감 4.9° — 11월 18일')
  })
})

describe('R3 (stack17: round 2 holds=4 asked=5 words=none left=9824 → "5개 중 4개만 찾았어요")', () => {
  it('R3: six rows with a listing page among them reach the model as they are: the host adds no row, drops none and writes no short count; opening the listing is the model\'s step', async () => {
    const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘'
    const rows = [
      row('https://chosunbiz.example/1', '제너레잇, 누적 60억 투자 유치', '건축 설계 자동화 스타트업 제너레잇이 누적 60억원 투자를 유치했다'),
      row('https://sbsbiz.example/2', '피클, 와이콤비네이터 투자 유치', 'AI 결제 스타트업 피클이 와이콤비네이터 등에서 투자를 유치했다'),
      row('https://asiae.example/3', '메디인테크, 338억 시리즈C 투자 유치', '의료로봇 스타트업 메디인테크가 338억원 규모 시리즈C 투자를 유치했다'),
      row('https://fnnews.example/4', '펨테크 스타트업 7곳, 투자 유치 추진', '펨테크 스타트업 7곳이 실리콘밸리에서 기업설명회를 열었다'),
      row('https://venture.example/5', '이번 주 AI 스타트업 투자 한눈에', '이번 주 국내 AI 스타트업 투자 소식 모음'),
      row('https://ai.example/6', '업스테이지, 시리즈C 투자 유치', 'AI 스타트업 업스테이지가 시리즈C 투자를 유치했다'),
    ]
    const s = search([page('q', rows)])
    const out = await looking(s).run({ query: 'q' }, { task: ask })
    console.log(`R3 replay: searches ${s.queries.join(' | ')}\n${out}`)
    expect(s.queries).toEqual(['q'])
    expect(out).not.toMatch(/4 of the 5|5개 중 4개|of these rows are from the period asked/)
    expect(urls(out)).toEqual(rows.map(one => / — (https?:\S+)/.exec(one)![1]!))
    expect(out.split('\n')).toHaveLength(rows.length + 1)
  })
})

describe('D1 (stack17: desk-check rewritten kinds=["asks"]; no 할 일 part, the 미결 line in 한다체)', () => {
  const SOURCE = [
    '# 제품팀 주간 회의록', '',
    '## 결정사항', '',
    '1. 신규 온보딩 화면 시안 확정 — 담당: 한서연, 기한: 11월 20일', '2. 결제 모듈 교체 일정 수립 — 담당: 오태민, 기한: 11월 24일', '3. 베타 테스터 50명 모집 공지 발송 — 담당: 윤가은, 기한: 11월 27일', '4. 4분기 마케팅 예산안 제출 — 담당: 백도현, 기한: 12월 1일', '',
    '## 미결', '', '- 결제 모듈 후보 두 곳 중 어디로 갈지는 견적을 받은 뒤 다음 회의에서 정한다.', '- 다음 회의: 11월 23일(월) 오전 10시',
  ].join('\n')
  const TASKS = ['신규 온보딩 화면 시안 확정 — 담당: 한서연, 기한: 11월 20일', '결제 모듈 교체 일정 수립 — 담당: 오태민, 기한: 11월 24일', '베타 테스터 50명 모집 공지 발송 — 담당: 윤가은, 기한: 11월 27일', '4분기 마케팅 예산안 제출 — 담당: 백도현, 기한: 12월 1일']
  const HANDA = '결제 모듈 후보 두 곳 중 어디로 갈지는 견적을 받은 뒤 다음 회의에서 정한다.'
  const DRAFT = ['11월 16일 제품팀 주간 회의록을 결정사항과 할 일 중심으로 정리했어요.', '', '결정사항', '', ...TASKS, '', '미결', '', HANDA, '다음 회의: 11월 23일(월) 오전 10시'].join('\n')
  it('D1: the draft with no 할 일 part and a 한다체 line is posted as the model wrote it; the register and what the reply holds are the model\'s rules, and no scoped repair exists', async () => {
    const out = await posted(DRAFT, '회의 메모에서 정해진 것과 맡은 일만 추려줘')
    console.log(`D1 replay:\n${out}`)
    expect(out).toBe(DRAFT)
    expect(out.split('\n')).toContain(HANDA)
    for (const task of TASKS) expect(SOURCE).toContain(task)
    expect(COLLEAGUE_CORE_RULE).toContain('in Korean keep the polite-casual -요 form through the whole reply')
    expect(COLLEAGUE_CORE_RULE).toContain('Your reply reaches the person exactly as you write it, so write it finished')
    expect(fns(desk)).toEqual(DESK_FNS)
  })
})

describe('C6 (stack17: writer=fallback:items-first>items-first; "서연이 지민이 찾은 … 만든 거예요" right after the ack)', () => {
  const ACK = '지민이 한 걸 서연한테 넘겼어요.'
  const COPY = ['12월 2~4일, 코엑스에서 소프트웨이브 2026이 열려요. 입장료 무료, 일반 참관객은 3일이나 4일 방문을 추천해요.', '12월 서울, ACC 2026에서 생성형 AI 등 최신 IT 기술 트렌드를 만나보세요.', '12월 서울, 네이버클라우드플랫폼 AI Expert 공인교육으로 AI 역량을 키워보세요.']
  it('C6: after the ack, the lead is handed 서연\'s copy lines as she wrote them and 지민\'s finds; the one attribution sentence is the lead model\'s to write, by the voice rule', () => {
    const settled = (m: TeamMember, answer: string, sources: string[] = []): TeamMember => { const one = { ...m }; settleMember(one, { answer, sources }, new Date().toISOString(), true); return one }
    const at = new Date().toISOString(), COEX = 'https://coex.example/softwave', ZDNET = 'https://zdnet.example/acc', NCLOUD = 'https://ncloud.example/edu'
    const jimin = settled({ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '12월 기술 모임 날짜 조사', topic: '기술 모임', botId: 'bot-m1', lookup: true, background: true, state: 'working', sessionKey: 's1', hiredAt: at, then: { botId: 'bot-m2', who: '서연', brief: '초대 글귀 세 줄 쓰기' } },
      `소프트웨이브 2026은 12월 2일부터 4일까지 코엑스에서 열려요. 입장료는 무료예요. ${COEX}\nACC 2026이 12월에 서울에서 열려요. ${ZDNET}\n네이버클라우드플랫폼이 12월에 서울에서 AI Expert 공인교육을 해요. ${NCLOUD}`, [COEX, ZDNET, NCLOUD])
    const seoyeon = settled({ id: 'm2', parentId: null, depth: 1, role: '서연', brief: handoffBrief('초대 글귀 세 줄 쓰기', '지민', jimin.result!, jimin.brief), botId: 'bot-m2', writer: true, background: true, state: 'working', sessionKey: 's2', hiredAt: at }, COPY.join('\n'))
    const out = JSON.parse(handBacks([jimin, seoyeon])) as { reports: { who: string; result: string }[]; note: string }
    console.log(`C6 replay (after "${ACK}"):\n${out.reports[1]!.result}`)
    expect(out.reports[1]).toMatchObject({ who: '서연', result: COPY.join('\n') })
    expect(JSON.stringify(out.reports)).not.toMatch(/만든 거예요/)
    for (const url of [COEX, ZDNET, NCLOUD]) expect(out.reports[0]!.result).toContain(url)
    expect(COLLEAGUE_CORE_RULE).toContain('tell it the way a team would - who found or made what and who took it from there, in a natural sentence')
    expect(Object.keys(out)).toEqual(['reports', 'note'])
  })
})
