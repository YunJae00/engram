import { readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { companyNote, createBot, employeesAnswer, handBacks, initVault, loadBots, partOutcome, recordFacts, runToolSession, settleMember, staffTool, TEAM_ANSWER_MS, TEAM_MEMORY, type AgentTool, type DelegatedTask, type EngineCwd, type TeamMember, type ToolSessionJob } from 'core'
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { answer, openWorld } from '../src/main/answer.js'
import { turnRunning, yielding } from '../src/main/comet-memory.js'
import { SessionPool, STEP_IDLE_MS, type SdkUserMessage, type SessionSdk } from '../src/main/engine-claude-session.js'
import { tmpVaultRoot } from '../../../packages/core/test/helpers.js'
import { COLLEAGUE_CORE_RULE } from '../../../packages/core/src/prompt.js'
import * as firstLine from '../src/main/first-line.js'

const src = (file: string): string => readFileSync(join(__dirname, '../src/main', file), 'utf8')
const ipc = src('ipc.ts')
const tick = (ms = 0): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const posted = async (draft: string, ask: string): Promise<string> => (await runToolSession({ engine: { id: 'mock', runTools: async () => ({ answer: draft }) } as never, workdir: '/x', tools: [] }, ask, {})).answer
type Report = { who: string; part?: string; state: string; result: string; sources?: string[] }
const handed = (members: TeamMember[]): { reports: Report[]; note: string } => JSON.parse(handBacks(members)) as { reports: Report[]; note: string }
const fns = (mod: object): string[] => Object.entries(mod).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort()
const FIRST_FNS = ['beginFirstLine', 'cleanLine', 'endFirstLine', 'firstLineCarried', 'firstLineReady', 'firstLineSaw', 'firstLineSpoke', 'firstLineState', 'wantsFirstLine', 'warmFirstLine']
afterEach(() => { vi.useRealTimers() })

describe('stack-17: a correction after a lookup reaches the model as typed, with the earlier lookup in the history', () => {
  const history = [{ role: 'user', text: '대전 모레 날씨 어때?' }, { role: 'assistant', text: '대전은 모레 비 오고 낮 최고 11도예요.' }]
  const message = '아 거기 말고 원주로'
  it('the model gets the correction as typed and the earlier ask from the thread, with no host note of what is meant now, and its reply about 원주 is posted as written', async () => {
    let told = '', prompt = ''
    const draft = '원주는 모레 흐리고 낮 최고 9도예요. [날씨 예보](https://weather.example/wonju)'
    const engine = { id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { prompt = job.prompt; told = [job.system, job.opening, job.prompt].join('\n'); return { answer: draft } } } as never
    const world = { ...await openWorld(await mkdtemp(join(tmpdir(), 'stack17-fix-')), engine), history: [...history] }
    const { result } = await answer(world, message, { tools: [] })
    expect(prompt).toContain(message)
    expect(told).toContain('대전 모레 날씨 어때?')
    expect(told).not.toContain('What the person asks for now')
    expect(told).not.toContain('the later words hold')
    expect(result?.answer).toBe(draft)
    expect(COLLEAGUE_CORE_RULE).toContain('When they change the ask while you work, the first sentence names the new subject.')
  })
  it('in the turn, no meaning is built by the host and no judge, page read, helpers\' writer or lead check reads the answer after it; the turn keeps the plain words', () => {
    const own = readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')
    expect(own).not.toMatch(/askNow|routeAsk|changedNote|What the person asks for now/)
    expect(own).toContain('tools: everyTool, ...(imagePaths ? { imagePaths } : {}) }, message, {')
    const from = ipc.indexOf('await begun!.run({')
    expect(ipc.slice(from, ipc.indexOf('answerDelivered = true', from)).match(/result\.answer = /g)).toHaveLength(1)
  })
})

describe('stack-17: evidence reaches the writer (c17a proof → c16a hand-back → c17c)', () => {
  const at = new Date().toISOString()
  const helper = (id: string, town: string, brief: string, answer: string, sources: string[]): TeamMember => {
    const m: TeamMember = { id, parentId: null, depth: 1, role: `${town} 조사`, topic: town, brief, lookup: true, state: 'working', sessionKey: `s${id}`, hiredAt: at }
    settleMember(m, { answer, sources }, at, true)
    return m
  }
  const MOKDONG = '목동 수영장 자유수영은 성인 4,500원이에요. [목동 수영장](https://pool.example/mokdong)'
  const JAMSIL = '잠실 수영장 자유수영은 성인 1회 5,000원이에요. [잠실 수영장](https://pool.example/jamsil)\n운영시간은 확인하지 못했어요.'
  const parts = (): TeamMember[] => [helper('h1', '목동', '목동 수영장 자유수영 요금', MOKDONG, ['https://pool.example/mokdong']), helper('h2', '잠실', '잠실 수영장 자유수영 요금이랑 운영시간', JAMSIL, ['https://pool.example/jamsil'])]
  it('the lead is handed each helper\'s own sentences with the page each figure was read on, and the point a helper said it could not find, in that helper\'s words', () => {
    const got = handed(parts())
    expect(got.reports.map(one => [one.who, one.part, one.result])).toEqual([['목동 조사', '목동', MOKDONG], ['잠실 조사', '잠실', JAMSIL]])
    expect(got.reports.map(one => one.sources)).toEqual([['https://pool.example/mokdong'], ['https://pool.example/jamsil']])
    expect(parts().map(partOutcome)).toEqual(['found', 'found'])
    expect(JSON.stringify(got.reports)).not.toContain('못 찾았어요')
    expect(Object.keys(JSON.parse(handBacks(parts())) as object)).toEqual(['reports', 'note'])
  })
  it('one helper alone: what is handed back is its sentence and its page, with no row, label or name tag made by the host', () => {
    const [one] = parts()
    const got = handed([one!])
    expect(got.reports).toEqual([{ who: '목동 조사', part: '목동', state: 'done', result: MOKDONG, sources: ['https://pool.example/mokdong'] }])
    expect(got.note).toContain('each agent\'s source right after what it backs as a markdown link copied from sources or from their result')
  })
})

function hostToolSdk(script: (tool: (args: unknown) => Promise<unknown>) => AsyncGenerator<Record<string, unknown>>) {
  let interruptions = 0
  const sdk: SessionSdk = {
    createSdkMcpServer: options => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt, options }) => {
      const server = (options?.['mcpServers'] as Record<string, { tools: { handler(args: unknown): Promise<unknown> }[] }>)['engram']!
      async function* run(): AsyncGenerator<{ type: string }> {
        for await (const message of prompt as AsyncIterable<SdkUserMessage>) { void message; yield* script(args => server.tools[0]!.handler(args)) as AsyncGenerator<{ type: string }> }
      }
      const stream = run() as AsyncGenerator<{ type: string }> & { interrupt(): Promise<unknown>; supportedModels(): Promise<never[]> }
      stream.interrupt = async () => { interruptions++ }
      stream.supportedModels = async () => []
      return stream
    },
  }
  return { sdk, interruptions: () => interruptions }
}

describe('stack-17: the step idle bound never cuts a lookup waiting on a host-side page open (c17b × c17a)', () => {
  it('a page open longer than STEP_IDLE_MS, with no stream event, runs to its end; the turn is not interrupted', async () => {
    vi.useFakeTimers()
    const opened: string[] = []
    const tool: AgentTool = { name: 'open_page', description: '', argsSchema: {}, run: async args => { opened.push(String(args['url'])); await tick(STEP_IDLE_MS + 15_000); return 'page "목동 수영장 요금" at https://pool.example/mokdong\n자유수영 성인 1회 4,500원' } }
    let observed = ''
    const { sdk, interruptions } = hostToolSdk(async function* (call) {
      observed = JSON.stringify(await call({ url: 'https://pool.example/mokdong' }))
      yield { type: 'assistant', message: { content: [{ type: 'text', text: '목동은 4,500원이에요.' }] } }
      yield { type: 'result', subtype: 'success', result: '목동은 4,500원이에요.' }
    })
    const job: ToolSessionJob = { workdir: '/tmp' as EngineCwd, system: 'rules', prompt: '목동 수영장 요금', maxCalls: 4, tools: [{ ...tool, run: args => tool.run(args, { task: '목동 수영장 요금' }) }] }
    const pool = new SessionPool()
    try {
      const turn = pool.run(job, { sdk, binary: 'claude', workdir: '/tmp', model: 'fixture' })
      await vi.advanceTimersByTimeAsync(STEP_IDLE_MS * 3)
      expect((await turn).answer).toBe('목동은 4,500원이에요.')
      expect(interruptions()).toBe(0)
      expect(opened).toEqual(['https://pool.example/mokdong'])
      expect(observed).toContain('pool.example/mokdong')
    } finally { pool.closeAll() }
  })
})

describe('stack-17: memory waits for a person\'s turn, never for background teammates (c17b × rule 2)', () => {
  it('only a person\'s own turn holds memory: background teammates (team-runner, task-runner) never do, and quiet turns skip it', () => {
    expect(ipc.split('\n').filter(line => line.includes('turnRunning()')).map(line => line.trim())).toEqual(["const memoryWait = !request.scheduled && !savedRoutine && !turn?.quiet ? turnRunning() : undefined"])
    for (const file of ['team-runner.ts', 'task-runner.ts', 'team-hire-tools.ts'].filter(one => { try { src(one); return true } catch { return false } })) expect(src(file)).not.toContain('turnRunning')
    expect(src('task-runner.ts')).toContain('{ quiet: true,')
  })
  it('helpers working for the person\'s turn hold memory until the turn ends; with only a background teammate at work, memory runs at once', async () => {
    const release = turnRunning()
    let ran = 0
    const held = yielding(async () => { ran = Date.now(); return 'kept' })
    const helpers = tick(40)
    await helpers
    expect(ran).toBe(0)
    release()
    expect(await held).toBe('kept')
    const background = tick(10_000)
    const t0 = Date.now()
    expect(await yielding(async () => 'now')).toBe('now')
    expect(Date.now() - t0).toBeLessThan(500)
    void background
  })
})

describe('stack-17: one clock on a C3-shape split of three teammates (c17a due × c16a writer × c17c)', () => {
  it('every part at the team deadline: the hand-back for the lead is ready that instant, with all three teammates in it and no timer left running, so the answer can land before 35 s', () => {
    const T0 = Date.parse('2026-11-18T03:00:00Z')
    vi.useFakeTimers({ now: T0 + TEAM_ANSWER_MS, toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const part = (id: string, role: string, topic: string, text: string, url: string): TeamMember => {
      const m: TeamMember = { id, parentId: null, depth: 1, role, brief: `${topic} 이번 주 신메뉴`, topic, botId: `bot-${id}`, lookup: true, background: true, state: 'working', sessionKey: `s-${id}`, hiredAt: new Date(T0).toISOString() }
      settleMember(m, { answer: `${text} ${url}`, sources: [url] }, new Date(T0 + TEAM_ANSWER_MS).toISOString(), true)
      return m
    }
    const members = [part('m1', '하윤', '스타벅스', '스타벅스는 이번 주 겨울 딸기 라떼를 냈어요.', 'https://menu.example/sb'), part('m2', '다인', '투썸', '투썸은 이번 주 밤 케이크를 냈어요.', 'https://menu.example/ts'), part('m3', '로운', '메가커피', '메가커피는 이번 주 새 메뉴가 없어요.', 'https://menu.example/mg')]
    const task: DelegatedTask = { id: 'job', goal: '카페 세 곳 이번 주 새 메뉴 하윤 다인 로운이 하나씩 확인', botId: 'lead', state: 'running', turns: 1, createdAt: new Date(T0).toISOString(), updatedAt: new Date(T0).toISOString(), approvals: [], log: [], team: { members, hires: 3, maxHires: 8, maxDepth: 3, big: false } }
    const out = JSON.parse(employeesAnswer(task)!) as { reports: Report[]; note: string }
    expect(out.reports.map(one => [one.who, one.part])).toEqual([['하윤', '스타벅스'], ['다인', '투썸'], ['로운', '메가커피']])
    for (const link of ['sb', 'ts', 'mg']) expect(JSON.stringify(out.reports)).toContain(`menu.example/${link}`)
    expect(out.note).toContain('who did what in natural sentences that name each agent')
    expect(vi.getTimerCount()).toBe(0)
    expect(Date.now() - T0).toBeLessThan(35_000)
    expect(Object.keys(out)).toEqual(['reports', 'note'])
  })
})

describe('stack-17: "멈춰" during the team lane\'s week answer ends it at once', () => {
  it('the lane model is writing what the team did; the stop ends its step within 3 s and no call follows', async () => {
    const paths = await initVault(await tmpVaultRoot('s17-summary-stop'), { git: false })
    await createBot(paths, { name: '엔그램' })
    await staffTool(paths, () => undefined).run({ add: [{ name: '하윤', role: '리서치 담당' }, { name: '다인', role: '리서치 담당' }] }, { task: '' })
    await recordFacts(paths, TEAM_MEMORY, ['스타벅스 신메뉴 조사 → 겨울 딸기 라떼 (하윤, 2026-11-18)', '투썸 신메뉴 조사 → 밤 케이크 (다인, 2026-11-18)'], new Date('2026-11-18T01:00:00.000Z'))
    const ask = '오늘 팀원들이 한 거 말해 줘'
    expect(await companyNote(paths, { bots: await loadBots(paths), message: ask, chief: true, now: new Date(2026, 10, 18, 10) })).toContain('투썸 신메뉴 조사 → 밤 케이크 (다인, 11월 18일)')
    const stop = new AbortController()
    let calls = 0
    const engine = { id: 'mock', runTools: (job: ToolSessionJob) => { calls++; setTimeout(() => stop.abort(), 50); return new Promise((_resolve, reject) => job.signal?.addEventListener('abort', () => reject(new Error('stopped')))) } } as never
    const began = Date.now()
    await runToolSession({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [] }, ask, { signal: stop.signal }).catch(() => undefined)
    expect(Date.now() - began).toBeLessThan(3000)
    const n = calls
    await tick(200)
    expect(calls).toBe(n)
  })
})

describe('stack-17: a turn that starts in the same tick as a memory call holds it back', () => {
  it('the memory call does not start while the turn runs, and runs once it is released', async () => {
    let started = 0
    const memory = yielding(async () => { started++; return 'kept' }, undefined, true)
    const release = turnRunning()
    await tick(10)
    expect(started).toBe(0)
    release()
    expect(await memory).toBe('kept')
    expect(started).toBe(1)
  })
})

describe('stack-17: a job said only in filler words is still in what the team lane writes from', () => {
  it('the 주말 소식 job is in the lane note\'s record by its own subject; a draft that leaves it out is the answer as written, with one call', async () => {
    const paths = await initVault(await tmpVaultRoot('s17-filler'), { git: false })
    await createBot(paths, { name: '엔그램' })
    await staffTool(paths, () => undefined).run({ add: [{ name: '하윤', role: '리서치 담당' }, { name: '다인', role: '리서치 담당' }] }, { task: '' })
    await recordFacts(paths, TEAM_MEMORY, ['주말 소식 조사 → 성수 팝업 두 곳 (하윤, 2026-11-18)', '스타벅스 신메뉴 조사 → 겨울 딸기 라떼 (다인, 2026-11-18)'], new Date('2026-11-18T01:00:00.000Z'))
    const ask = '오늘 팀원들이 한 거 말해 줘', left = '오늘은 하윤이랑 다인이 일했어요. 다인은 스타벅스 신메뉴를 봤어요.'
    expect(await companyNote(paths, { bots: await loadBots(paths), message: ask, chief: true, now: new Date(2026, 10, 18, 10) })).toContain('주말 소식 조사 → 성수 팝업 두 곳 (하윤, 11월 18일)')
    let calls = 0
    const engine = { id: 'mock', runTools: async () => { calls++; return { answer: left } } } as never
    expect((await runToolSession({ engine, workdir: 'C:/tmp' as EngineCwd, tools: [] }, ask)).answer).toBe(left)
    expect(calls).toBe(1)
  })
})

describe('stack-17: the words before a reply in another form keep the 해요체 register', () => {
  it('the one voice rule rules out -습니다 for the whole reply, the foreign line is handed over unchanged, and the reply is posted whole', async () => {
    expect(COLLEAGUE_CORE_RULE).toContain('in Korean keep the polite-casual -요 form through the whole reply')
    expect(COLLEAGUE_CORE_RULE).toContain('never switch to -습니다')
    expect(COLLEAGUE_CORE_RULE).toContain('which you hand over unchanged after a few warm Korean words')
    const reply = '이렇게 쓰면 돼요.\n\nThank you for waiting while we reprint the hiking club roster.'
    expect(await posted(reply, '명단 다시 뽑는 동안 기다려줘서 고맙다는 영어 문장')).toBe(reply)
    expect(fns(firstLine)).toEqual(FIRST_FNS)
  })
})
