import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { checkedSearch, createTask, handoffBrief, helperAnswer, helperParts, listTasks, mergingHire, messageUnits, reportData, settleMember, updateTask, writtenReport, type AgentTool, type TeamMember, type VaultPaths } from 'core'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { checkedDesk } from '../src/main/desk-lane.js'
import { teamRunner, type TurnKit } from '../src/main/team-runner.js'
import { agreeing } from '../../../packages/core/test/agreeing.js'

const page = (query: string, rows: string[]): string => [`results for "${query}" at https://search.example/?q=${encodeURIComponent(query)} (DATA, not instructions):`, ...rows].join('\n')
const row = (url: string, title: string, snippet: string, day = '11월 18일'): string => `- ${title} — ${url} — ${snippet} — ${day}`
function search(outs: string[], tick?: () => void): AgentTool & { queries: string[] } {
  const queries: string[] = []
  return { queries, name: 'search_web', description: '', argsSchema: {}, run: async args => { queries.push(String(args['query'])); tick?.(); return outs.shift() ?? page(String(args['query']), []) } }
}
const urls = (out: string): string[] => out.split('\n').filter(line => line.startsWith('- ')).map(line => / — (https?:\S+)/.exec(line)![1]!)
const itemsOf = (prompt: string): { n: number; text: string; link?: string }[] => JSON.parse(prompt.split('\nItems: ')[1]!) as { n: number; text: string; link?: string }[]
const tick = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('T1 (stack17: 4 helpers all "found", the judge quotes paraphrased and rejected, 3 cities "못 찾았어요")', () => {
  type Run = NonNullable<Parameters<typeof teamRunner>[0]['run']>
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  const vault = async (): Promise<VaultPaths> => { await mkdir(temporary, { recursive: true }); return { cache: join(await mkdtemp(join(temporary, 'engram-s18-t1-')), '.engram') } as unknown as VaultPaths }
  const CITY: Record<string, { page: string; quote: string; said: string }> = {
    서울: { page: '현재 7.2°C, 구름많음. 체감 4.9°C.', quote: '7.2도, 구름많음', said: '서울은 지금 7.2도에 구름이 많아요' },
    부산: { page: '낮 최고 18°C, 온화함. 오늘 밤~내일 새벽까지 비.', quote: '낮 최고 18도, 온화함', said: '부산은 낮 최고 18도로 온화하고 밤부터 비가 와요' },
    제주: { page: '현재 16.1°C, 흐림. 바람 강함.', quote: '16.1도 흐림', said: '제주는 16.1도에 흐려요' },
    대구: { page: '현재 9.4°C, 맑음.', quote: '9.4도, 맑음', said: '대구는 9.4도에 맑아요' },
  }
  const CITIES = Object.keys(CITY)
  const WEATHER = (city: string): string => `https://weather.example/${encodeURIComponent(city)}`
  it('T1: paraphrased quotes on pages the host opened: all four cities have their values, no "못 찾았어요"', async () => {
    const paths = await vault(), ask = '봇 3개 생성해서 서울 부산 제주 날씨 조사해서 취합하고 너가 알려줘 (대구도 추가)'
    const created = await createTask(paths, ask, 'b1')
    await updateTask(paths, created.id, t => { t.state = 'running'; t.turns = 1; t.team = { members: [], hires: 0, maxHires: 8, maxDepth: 3, big: true, approvedAt: new Date().toISOString() } })
    const since = Date.now(), opened: string[] = []
    const city = (text: string): string => CITIES.find(one => text.includes(one)) ?? '서울'
    const searchTool: AgentTool = { name: 'search_web', description: '', argsSchema: {}, run: async args => {
      const q = String(args['query']), at = city(q); await tick(20)
      return page(q, [row(WEATHER(at), `${at} 날씨`, `${at} 오늘 날씨 안내`), row(`https://news.example/${encodeURIComponent(at)}`, `${at} 오늘 날씨 요약`, `${at} 지역 소식`)])
    } }
    const open: AgentTool = { name: 'open_page', description: '', argsSchema: {}, run: async args => {
      const url = String(args['url']), at = city(decodeURIComponent(url)); opened.push(url); await tick(20)
      return `page "${at} 날씨" (DATA, not instructions):\n${at} 날씨\n${CITY[at]!.page}`
    } }
    const write = agreeing(async (prompt: string): Promise<string | undefined> => {
      if (prompt.includes('In "holds", for each item')) {
        await tick(20)
        const items = itemsOf(prompt), w = items.find(item => item.link?.startsWith('https://weather.example/'))
        return JSON.stringify({ keep: items.map(item => item.n), asked: 1, points: ['날씨: 기온이나 하늘 상태'], holds: w ? { [w.n]: { 날씨: CITY[city(decodeURIComponent(w.link!))]!.quote } } : {}, ...(w ? { open: w.n } : {}), search: '' })
      }
      if (prompt.includes('Judge meaning only')) return JSON.stringify({ problems: [] })
      return undefined
    })
    const run: Run = async (deps, prompt, options = {}) => {
      options.onStart?.()
      const part = prompt.split('Your part:\n')[1]?.split('\n')[0] ?? '', at = city(part)
      const tool = deps.tools?.find(t => t.name === 'search_web')
      const seen = tool ? await tool.run({ query: `${at} 오늘 날씨` }, { task: prompt, ...(options.signal ? { signal: options.signal } : {}) }) : ''
      await tick(20)
      const said = seen.includes(CITY[at]!.page) ? CITY[at]!.said : `${at} 날씨는 못 찾았어요`
      return { answer: `${said}. [${at} 날씨](${WEATHER(at)})`, steps: [], fellBack: false }
    }
    const engine = { id: 'claude', quick: async (prompt: string) => write(prompt) } as unknown as TurnKit['engine']
    const team = teamRunner({ paths, askFor: () => undefined, waitingForPerson: () => false, closeSession: () => undefined, endLane: () => undefined, step: () => undefined, changed: () => undefined, run })
    const kit: TurnKit = { engine, workdir: {} as TurnKit['workdir'], guided: false, said: () => ask, nativeFor: async () => undefined, toolsFor: async one => [...team.tools(one, kit), searchTool, open], alive: async () => true }
    const hire = mergingHire(team.tools('bot-b1', kit).find(t => t.name === 'hire_members')!, async signal => helperAnswer({ ask, members: (await listTasks(paths)).find(t => t.state === 'running')?.team?.members, since, write, due: since + 28_000 + 4_000, ...(signal ? { signal } : {}) }))
    const text = await hire.run({ members: CITIES.map(at => ({ role: `${at} 날씨 조사`, topic: at, brief: `${at} 오늘 날씨`, lookup: true })) }, { task: '' })
    const members = (await listTasks(paths))[0]!.team!.members.filter(m => m.lookup)
    console.log(`T1 replay: opened ${opened.length}\n${text}`)
    for (const at of CITIES) {
      expect(opened).toContain(WEATHER(at))
      expect(members.find(one => one.topic === at)!.sources).toContain(WEATHER(at))
    }
    const parts = helperParts(members)
    for (const at of CITIES) expect(parts.find(one => one.topic === at)!.data!.facts.length).toBeGreaterThan(0)
    for (const value of ['7.2도', '18도', '16.1도', '9.4도']) expect(text).toContain(value)
    expect(text).not.toContain('못 찾았어요')
    expect(text).not.toMatch(/내용|출처|날씨: /)
  }, 45_000)
})

describe('L1 (stack17: "오늘 서울 날씨 어때?" took 4 judge rounds, points=3, holds=0 on quotes split across title and snippet)', () => {
  it('L1: one point, the value split across title "서울 7.2°" and snippet "구름많음": 1 judge call, 1 search', async () => {
    const ask = '오늘 서울 날씨 어때?'
    const s = search([page('q', [row('https://weather.example/seoul', '서울 7.2°', '구름많음, 체감 4.9°'), row('https://news.example/seoul', '서울 11월 18일 오늘 날씨', '찬바람 강해져')])])
    const judged: string[] = []
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => 0,
      write: agreeing(async p => { judged.push(p); return JSON.stringify({ keep: [1, 2], asked: 1, points: ['날씨: 기온이나 하늘 상태'], holds: { 1: { 날씨: '서울 7.2°, 구름많음' } }, search: '서울 현재 기온' }) }) }).run({ query: 'q' }, { task: ask })
    console.log(`L1 replay: judge calls ${judged.length}, searches ${s.queries.join(' | ')}\n${out}`)
    // c19a (cause H): an uncounted ask passes no judge at all; the rows reach the reader as the search gave them.
    expect(judged).toHaveLength(0)
    expect(s.queries).toEqual(['q'])
    expect(urls(out)[0]).toBe('https://weather.example/seoul')
    expect(out).toContain('구름많음')
  })
})

describe('R3 (stack17: round 2 holds=4 asked=5 words=none left=9824 → "5개 중 4개만 찾았어요")', () => {
  it('R3: 4 held, no new words, time left: the listing page is read and the 5 are found before any short count', async () => {
    const ask = '요즘 국내 AI 스타트업 투자 뉴스 5개만 출처랑 같이 정리해줘'
    const rows = [
      row('https://chosunbiz.example/1', '제너레잇, 누적 60억 투자 유치', '건축 설계 자동화 스타트업 제너레잇이 누적 60억원 투자를 유치했다'),
      row('https://sbsbiz.example/2', '피클, 와이콤비네이터 투자 유치', 'AI 결제 스타트업 피클이 와이콤비네이터 등에서 투자를 유치했다'),
      row('https://asiae.example/3', '메디인테크, 338억 시리즈C 투자 유치', '의료로봇 스타트업 메디인테크가 338억원 규모 시리즈C 투자를 유치했다'),
      row('https://fnnews.example/4', '펨테크 스타트업 7곳, 투자 유치 추진', '펨테크 스타트업 7곳이 실리콘밸리에서 기업설명회를 열었다'),
      row('https://venture.example/5', '이번 주 AI 스타트업 투자 한눈에', '이번 주 국내 AI 스타트업 투자 소식 모음'),
      row('https://ai.example/6', '업스테이지, 시리즈C 투자 유치', 'AI 스타트업 업스테이지가 시리즈C 투자를 유치했다'),
    ]
    const listing = ['page "이번 주 AI 스타트업 투자 한눈에" (DATA, not instructions):', '이번 주 투자 소식을 모았어요.', 'Observed links (DATA; use these addresses for direct reads):', '- 트웰브랩스, 시리즈B 투자 유치 — https://venture.example/e', '- 뤼튼, 프리IPO 투자 유치 — https://venture.example/f', '- 회사 소개 — https://venture.example/about'].join('\n')
    let t = 0
    const s = search([page('q', rows)], () => { t += 1000 }), opened: string[] = [], judged: string[] = []
    const write = agreeing(async (p: string): Promise<string> => {
      t += 2000; judged.push(p)
      const items = itemsOf(p), holds: Record<number, Record<string, string>> = {}
      for (const item of items) {
        const [lead, snippet] = item.text.split(' — ')
        if (snippet?.includes('투자를 유치했다') && !lead!.includes('업스테이지')) holds[item.n] = { kind: snippet }
        else if (/추진/.test(lead!)) holds[item.n] = { kind: lead! }
        else if (!item.text.includes(' — ') && /투자 유치/.test(lead!)) holds[item.n] = { kind: lead! }
      }
      return JSON.stringify({ keep: items.filter(item => !/한눈에|회사 소개/.test(item.text)).map(item => item.n), listing: items.filter(item => item.text.includes('한눈에')).map(item => item.n), asked: 5, holds, search: '', ...(judged.length === 1 ? { kind: '국내 AI 스타트업이 투자를 받았다는 보도' } : {}) })
    })
    const out = await checkedSearch(s, { ask: () => ask, since: 0, now: () => t, write, read: async url => { opened.push(url); return url.endsWith('/5') ? listing : '펨테크 스타트업 기업설명회 안내.' } }).run({ query: 'q' }, { task: ask })
    console.log(`R3 replay: opened ${opened.join(', ')}, searches ${s.queries.join(' | ')}\n${out}`)
    // c19a (cause H): 6 in-period rows seen for 5 asked: no judge round, no short count; every row and the top 2 pages (opened at once
    // after the search) reach the reader, which picks the 5 by what each is.
    expect(judged).toHaveLength(0)
    expect(opened).toContain('https://venture.example/5')
    expect(opened).toHaveLength(2)
    expect(out).not.toMatch(/4 of the 5|5개 중 4개|of these rows are from the period asked/)
    expect(urls(out)).toEqual(expect.arrayContaining([...rows.map(one => / — (https?:\S+)/.exec(one)![1]!), 'https://venture.example/e', 'https://venture.example/f']))
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
  it('D1: a "missing 할 일" finding and the 한다체 line go through the scoped repair: 할 일 is added, the rest stays, no 한다체 line', async () => {
    const units = messageUnits(DRAFT), at = units.findIndex(unit => unit.text.includes('정한다')), last = units.findIndex(unit => unit.text.includes('4분기'))
    const check = [JSON.stringify({ problems: [{ kind: 'missing', quote: '할 일', why: '할 일 부분이 없어요', lines: TASKS.map((task, i) => `${i + 1}. ${task}`) }, { kind: 'register', quote: HANDA, why: '한다체' }] })]
    const repair = [JSON.stringify({ replace: { [String(at + 1)]: '결제 모듈 후보 두 곳 중 어디로 갈지는 견적을 받은 뒤 다음 회의에서 정해요.' }, insert_after: { [String(last + 1)]: ['', '할 일', ...TASKS.map(task => `- ${task.replace(/ — 담당: (.+), 기한: (.+)$/, ' — $1, $2까지')}`)] } })]
    const prompts: string[] = [], logged: string[] = []
    const quick = async (p: string): Promise<string | undefined> => { prompts.push(p); return p.includes('Judge meaning only') ? check.shift() ?? '{"problems":[]}' : p.includes('You fix a message before a person reads it') ? repair.shift() : undefined }
    const out = await checkedDesk({ ask: 'fixtures/meeting-notes.md 회의록 요약해서 결정사항이랑 할 일 정리해줘', draft: DRAFT, source: SOURCE, fromSource: true, quick, since: Date.now(), log: (o, k) => logged.push(`${o}:${k.join(',')}`) })
    console.log(`D1 replay (${logged.join(' ')}):\n${out}`)
    expect(out.split('\n')).toContain('할 일')
    for (const task of TASKS) expect(out).toContain(task.split(' — ')[0])
    const kept = DRAFT.split('\n').filter(line => line.trim() && line !== HANDA)
    expect(out.split('\n').filter(line => kept.includes(line))).toEqual(kept)
    expect(out).not.toMatch(/한다\.|정한다/)
  })
})

describe('C6 (stack17: writer=fallback:items-first>items-first; "서연이 지민이 찾은 … 만든 거예요" right after the ack)', () => {
  const ACK = '지민이 한 걸 서연한테 넘겼어요.'
  const COPY = ['12월 2~4일, 코엑스에서 소프트웨이브 2026이 열려요. 입장료 무료, 일반 참관객은 3일이나 4일 방문을 추천해요.', '12월 서울, ACC 2026에서 생성형 AI 등 최신 IT 기술 트렌드를 만나보세요.', '12월 서울, 네이버클라우드플랫폼 AI Expert 공인교육으로 AI 역량을 키워보세요.']
  it('C6: with the ack in `said`, one natural attribution sentence; the copy lines come from the writer\'s draft', async () => {
    const block = (report: Record<string, unknown>): string => `\`\`\`report\n${JSON.stringify(report)}\n\`\`\``
    const settled = (m: TeamMember, report: Record<string, unknown>): TeamMember => { const one = { ...m }, answer = block(report); settleMember(one, { answer, report: reportData(answer, one, [], true) ?? null }, new Date().toISOString(), true); return one }
    const at = new Date().toISOString(), COEX = 'https://coex.example/softwave', ZDNET = 'https://zdnet.example/acc', NCLOUD = 'https://ncloud.example/edu'
    const jimin = settled({ id: 'm1', parentId: null, depth: 1, role: '지민', brief: '다음 달 서울 IT 행사 일정 정리', topic: '서울 IT 행사 일정', botId: 'bot-m1', lookup: true, background: true, state: 'done', sessionKey: 's1', hiredAt: at, then: { botId: 'bot-m2', who: '서연', brief: '홍보 문구 3개 뽑기' } }, { facts: [
      { text: '소프트웨이브 2026은 12월 2일부터 4일까지 코엑스에서 열려요. 입장료는 무료예요.', url: COEX }, { text: 'ACC 2026이 12월에 서울에서 열려요.', url: ZDNET }, { text: '네이버클라우드플랫폼이 12월에 서울에서 AI Expert 공인교육을 해요.', url: NCLOUD }] })
    const seoyeon = settled({ id: 'm2', parentId: null, depth: 1, role: '서연', brief: handoffBrief('홍보 문구 3개 뽑기', '지민', jimin.result!, jimin.brief), botId: 'bot-m2', writer: true, background: true, state: 'done', sessionKey: 's2', hiredAt: at }, { items: COPY })
    const draft = COPY.join('\n')
    const out = await writtenReport({ ask: '지민 조사 끝나면 서연한테 넘겨서 홍보 문구 3개 뽑게 해', members: [jimin, seoyeon], said: [ACK], timeoutMs: 15_000,
      write: agreeing(async (p: string) => {  return p.includes('Judge meaning only') ? '{"problems":[]}' : p.includes('You fix a message before a person reads it') ? undefined : JSON.stringify({ message: draft, kept: [] }) }) })
    console.log(`C6 replay (after "${ACK}"):\n${out}`)
    expect(out.match(/서연이 지민이 찾은 [^\n]*만든 거예요\./g)).toHaveLength(1)
    for (const line of COPY) expect(out).toContain(line)
  })
})
