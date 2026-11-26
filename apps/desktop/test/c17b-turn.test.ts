import { readFileSync, existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentTool, Engine, EngineCwd, ToolSessionJob } from 'core'
const logged = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: logged }))
import { answer as answerTurn, openWorld } from '../src/main/answer.js'
import { turnRunning, yielding } from '../src/main/comet-memory.js'
import { SessionPool, STEP_IDLE_MS, type SdkUserMessage, type SessionSdk } from '../src/main/engine-claude-session.js'
import { COLLEAGUE_CORE_RULE, FILE_JOB_RULE } from '../../../packages/core/src/prompt.js'

const ipc = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')
const own = readFileSync(new URL('../src/main/answer.ts', import.meta.url), 'utf8')

type Turn = { role: 'user' | 'assistant'; text: string }
const scratch: string[] = []
afterEach(async () => { await Promise.all(scratch.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })
const leadWorld = async (draft: string | ((job: ToolSessionJob) => Promise<string>), history: Turn[] = []) => {
  const jobs: ToolSessionJob[] = []
  const engine = { id: 'mock', desktopToolIsolation: true, detect: async () => ({ installed: true, loggedIn: true }), run: async function* () { yield { type: 'result', text: '' } }, runTools: async (job: ToolSessionJob) => { jobs.push(job); return { answer: typeof draft === 'string' ? draft : await draft(job) } } } as unknown as Engine
  const dir = await mkdtemp(join(tmpdir(), 'c17b-turn-')); scratch.push(dir)
  const world = { ...await openWorld(dir, engine), history: [...history] }
  const told = (at = -1): string => { const job = jobs.at(at)!; return [job.system, job.opening ?? '', job.prompt].join('\n') }
  return { world, jobs, told }
}
const lead = async (said: string, history: Turn[], draft = '알겠어요.', tools: AgentTool[] = []) => {
  const { world, jobs, told } = await leadWorld(draft, history)
  const done = await answerTurn(world, said, { tools })
  return { done, jobs, told: told() }
}
const NO_HOST_NOTE = /What the person asks for now|The person then changed it|the later words hold/

describe('a correction reaches the model as typed, and the thread says what it changes', () => {
  const earlier: Turn[] = [{ role: 'user', text: '창고 재고표 stock-dec.csv에서 냉동 품목 수량 알려줘' }, { role: 'assistant', text: '냉동 품목은 312개예요.' }]
  const message = '아니 냉동 말고 냉장으로'
  it('a correction reaches the model as typed, with the earlier ask in the history and no host note on what is asked now', async () => {
    const { told, jobs } = await lead(message, earlier)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.prompt).toContain(message)
    expect(told).toContain('창고 재고표 stock-dec.csv에서 냉동 품목 수량 알려줘')
    expect(told.indexOf('냉동 품목은 312개예요.')).toBeLessThan(told.lastIndexOf(message))
    expect(told).not.toMatch(NO_HOST_NOTE)
  })
  it('a 냉장 reply the model writes after a build is posted exactly as written, and the build gets only the arguments the model gave', async () => {
    const draft = '냉장 품목 수량은 205개예요.\n\n표로도 넣어 뒀어요.'
    const seen: Record<string, unknown>[] = []
    const book: AgentTool = { name: 'file_create_workbook', description: 'makes a workbook', argsSchema: { type: 'object', properties: {}, required: [] }, run: async args => { seen.push(args); return JSON.stringify({ markdownLink: '[냉장-수량.xlsx](engram-artifact:cold-count.xlsx)' }) } }
    const { world, jobs } = await leadWorld(async job => { await job.tools.find(tool => tool.name === 'file_create_workbook')!.run({ name: '냉장-수량.xlsx' }, { task: message }); return draft }, earlier)
    const { result } = await answerTurn(world, message, { tools: [book] })
    expect(result!.answer).toBe(draft)
    expect(seen).toEqual([{ name: '냉장-수량.xlsx' }])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.tools.find(tool => tool.name === 'file_create_workbook')!.argsSchema).toEqual(book.argsSchema)
  })
  it('no check or rewrite stands between the draft and the person, so the later words reach the model itself', () => {
    expect(existsSync(new URL('../src/main/desk-lane.ts', import.meta.url))).toBe(false)
    expect(ipc.slice(ipc.indexOf('await begun!.run({'), ipc.indexOf('afterAnswer = async () => {')).match(/result\.answer = \w+/g)).toBeNull()
    expect(own).not.toMatch(/changedNote|askNow|routeAsk|What the person asks for now/)
    expect(own).toContain("context: { ...context?.(), calendar: calendarLine(), ...(said ? { firstLine: said } : {}) },")
    expect(COLLEAGUE_CORE_RULE).toContain('Your reply reaches the person exactly as you write it, so write it finished: nobody tidies, checks or completes it after you.')
  })
  it('a correction naming a new part reaches the model beside the ask it changes, and the rules for one part and one offer are the model\'s', async () => {
    const before: Turn[] = [{ role: 'user', text: '팀 일정표 week-plan.md에서 대전 출장 건만 골라줘' }, { role: 'assistant', text: '- 대전 출장: 12월 3일' }]
    const { told, jobs } = await lead('그냥 광주 걸로 바꿔', before)
    expect(jobs[0]!.prompt).toContain('그냥 광주 걸로 바꿔')
    expect(told).toContain('팀 일정표 week-plan.md에서 대전 출장 건만 골라줘')
    expect(told).not.toMatch(NO_HOST_NOTE)
    expect(COLLEAGUE_CORE_RULE).toContain('When they ask for one part of something, give that part only.')
    expect(FILE_JOB_RULE).toContain('ends with exactly ONE short offer line of something new that would really help')
  })
  it('a correction that widens the ask reaches the model with the earlier narrowing word before it', async () => {
    const before: Turn[] = [{ role: 'user', text: 'meeting/trim-02.md에서 결정만 추려줘' }, { role: 'assistant', text: '- 예산 동결' }]
    for (const widen of ['아니 그거 말고 전부 보여줘', '음 그거 말고 보류 건까지 같이']) {
      const { told, jobs } = await lead(widen, before)
      expect(jobs[0]!.prompt).toContain(widen)
      expect(told.indexOf('결정만 추려줘')).toBeGreaterThan(-1)
      expect(told.lastIndexOf(widen)).toBeGreaterThan(told.indexOf('결정만 추려줘'))
      expect(told).not.toMatch(NO_HOST_NOTE)
    }
  })
  it('along a chain of turns, answer keeps every correction in the history in order, and the latest one is the message', async () => {
    const { world, jobs, told } = await leadWorld('정리했어요.')
    for (const said of ['memo/garden-plan.md 정리해줘', '아니 그거 말고 물주기만', '음 그거 말고 처음 순서대로']) await answerTurn(world, said, { tools: [] })
    expect(jobs).toHaveLength(3)
    const last = told()
    expect(jobs[2]!.prompt).toContain('음 그거 말고 처음 순서대로')
    expect(last.indexOf('memo/garden-plan.md 정리해줘')).toBeGreaterThan(-1)
    expect(last.indexOf('아니 그거 말고 물주기만')).toBeGreaterThan(last.indexOf('memo/garden-plan.md 정리해줘'))
    expect(last.lastIndexOf('음 그거 말고 처음 순서대로')).toBeGreaterThan(last.indexOf('아니 그거 말고 물주기만'))
    expect(world.history.filter(turn => turn.role === 'user').map(turn => turn.text)).toEqual(['memo/garden-plan.md 정리해줘', '아니 그거 말고 물주기만', '음 그거 말고 처음 순서대로'])
    for (const at of [0, 1, 2]) expect(told(at)).not.toMatch(NO_HOST_NOTE)
  })
  it('successive corrections reach the model with the original task and every change in the history, oldest first', async () => {
    const turns: Turn[] = [
      { role: 'user', text: 'library/wishlist.md에서 올해 살 책만 골라줘' }, { role: 'assistant', text: '- 책 가' },
      { role: 'user', text: '아 그거 말고 다 넣어줘' }, { role: 'assistant', text: '- 책 가\n- 책 나' },
      { role: 'user', text: '아니 그거 말고 출판사별로' }, { role: 'assistant', text: '…' },
    ]
    const third = '음 그거 말고 가격순으로'
    const { told, jobs } = await lead(third, turns)
    const order = ['library/wishlist.md에서 올해 살 책만 골라줘', '아 그거 말고 다 넣어줘', '아니 그거 말고 출판사별로'].map(text => told.indexOf(text))
    expect(order.every(at => at > -1)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(told.lastIndexOf(third)).toBeGreaterThan(order[2]!)
    expect(jobs[0]!.prompt).toContain(third)
    expect(told).not.toMatch(NO_HOST_NOTE)
  })
  it('the model reads the meaning from the thread and the named file with its own call; no route or pre-read is left in answer or ipc', () => {
    for (const gone of ['namedText', 'namedBy', 'askNow', 'routeAsk', 'fileGiven', 'const meant', 'deskLane', 'deskKind', 'deskLight']) expect(own).not.toContain(gone)
    expect(ipc.split('\n').filter(line => /\brouted\b|\bdeskLane\(|\bdeskKind\(|\brouteAsk\(/.test(line))).toEqual([])
    expect(own).toContain('tools: everyTool,')
    expect(ipc).toMatch(/await deliverAnswer\(\s*result\.asked \? askText\(result\.answer, result\.options\) : result\.answer,/)
  })
  it('a reshape keeps every fact and constraint, and a changed fact is the model\'s to carry', async () => {
    expect(COLLEAGUE_CORE_RULE).toContain('write that reply again in the asked form with every fact and every constraint of the original ask kept, and nothing about what you changed.')
    expect(COLLEAGUE_CORE_RULE).toContain('means do the new thing at once - never ask which one they mean when the thread already says it')
    const { told, jobs } = await lead('조금만 더 짧게', [{ role: 'user', text: '대구 지점 할 일 알려줘' }, { role: 'assistant', text: '울산 지점 할 일은 두 개예요.' }])
    expect(jobs[0]!.prompt).toContain('조금만 더 짧게')
    expect(told).toContain('대구 지점 할 일 알려줘')
    expect(told).toContain('울산 지점 할 일은 두 개예요.')
    expect(told).not.toMatch(NO_HOST_NOTE)
  })
})

describe('memory waits while a person\'s turn runs', () => {
  const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
  it('a slow memory call queued between the turn\'s tools does not run next to the turn, and completes after release', async () => {
    const release = turnRunning()
    let started = 0
    const memory = yielding(async () => { started = Date.now(); await tick(30); return 'kept' })
    const t0 = Date.now()
    await tick(20)
    expect(Date.now() - t0).toBeLessThan(200)
    expect(started).toBe(0)
    const released = Date.now()
    release()
    expect(await memory).toBe('kept')
    expect(started).toBeGreaterThanOrEqual(released)
  })
  it('a call under way is cut when a turn starts and runs again only after that turn is released', async () => {
    let runs = 0
    const memory = yielding(signal => new Promise<string>((resolve, reject) => { runs++; if (runs > 1) return resolve('again'); signal.addEventListener('abort', () => reject(new Error('cut'))) }))
    await tick()
    const release = turnRunning()
    await tick(10)
    expect(runs).toBe(1)
    release()
    expect(await memory).toBe('again')
  })
})

type Script = (turn: { content: string; tool: (args: unknown) => Promise<unknown>; interrupted: Promise<void> }) => AsyncGenerator<Record<string, unknown>>
function scriptedSdk(scripts: Script[]) {
  let interruptions = 0
  const seen: string[] = []
  const sdk: SessionSdk = {
    createSdkMcpServer: options => options,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    query: ({ prompt, options }) => {
      const server = (options?.['mcpServers'] as Record<string, { tools: { handler(args: unknown): Promise<unknown> }[] }>)['engram']!
      let cut: () => void = () => {}
      async function* run(): AsyncGenerator<{ type: string }> {
        for await (const message of prompt as AsyncIterable<SdkUserMessage>) {
          seen.push(message.message.content)
          const interrupted = new Promise<void>(resolve => { cut = resolve })
          yield* scripts.shift()!({ content: message.message.content, tool: args => server.tools[0]!.handler(args), interrupted }) as AsyncGenerator<{ type: string }>
        }
      }
      const stream = run() as AsyncGenerator<{ type: string }> & { interrupt(): Promise<unknown>; supportedModels(): Promise<never[]> }
      stream.interrupt = async () => { interruptions++; cut() }
      stream.supportedModels = async () => []
      return stream
    },
  }
  return { sdk, interruptions: () => interruptions, seen }
}
const spec = (sdk: SessionSdk) => ({ sdk, binary: 'claude', workdir: '/tmp', model: 'fixture' })
const toolJob = (runs: { n: number }, extra: Partial<ToolSessionJob> = {}): ToolSessionJob => ({
  workdir: '/tmp' as EngineCwd, system: 'rules', prompt: 'make the deck', maxCalls: 12,
  tools: [{ name: 'file_read', description: 'read', argsSchema: { type: 'object', properties: {} }, run: async () => { runs.n++; return 'notes' } }],
  ...extra,
})
const callTool = async function* (tool: (args: unknown) => Promise<unknown>): AsyncGenerator<Record<string, unknown>> {
  yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__engram__file_read', id: 'call-1' } } }
  yield { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call-1', name: 'mcp__engram__file_read' }] } }
  await tool({})
  yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] } }
}
const answer = function* (text: string): Generator<Record<string, unknown>> {
  yield { type: 'assistant', message: { content: [{ type: 'text', text }] } }
  yield { type: 'result', subtype: 'success', result: text }
}

describe('a model step with no stream event is cut and asked again once', () => {
  afterEach(() => { vi.useRealTimers(); logged.mockClear() })
  it('a silent step after a tool is retried on a fresh request, the tool is not run twice, and the turn completes', async () => {
    vi.useFakeTimers()
    const runs = { n: 0 }
    const { sdk, interruptions, seen } = scriptedSdk([
      async function* ({ tool, interrupted }) { yield* callTool(tool); await interrupted; yield { type: 'result', subtype: 'error_during_execution' } },
      async function* ({ content }) { expect(content).toContain('do not make them again'); yield* answer('덱 만들었어요.') },
    ])
    const pool = new SessionPool()
    try {
      const turn = pool.run(toolJob(runs), spec(sdk))
      await vi.advanceTimersByTimeAsync(STEP_IDLE_MS + 1000)
      const result = await turn
      expect(result.answer).toBe('덱 만들었어요.')
      expect(result.error).toBeUndefined()
      expect(runs.n).toBe(1)
      expect(interruptions()).toBe(1)
      expect(seen).toHaveLength(2)
      expect(logged.mock.calls.some(([tag]) => tag === 'engine-stall')).toBe(true)
    } finally { pool.closeAll() }
  })
  it('a step that streams thinking slowly, and a long tool, are never cut', async () => {
    vi.useFakeTimers()
    const runs = { n: 0 }
    const { sdk, interruptions } = scriptedSdk([async function* ({ tool }) {
      for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, STEP_IDLE_MS - 5000)); yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '…' } } } }
      yield { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'mcp__engram__file_read', id: 'call-1' } } }
      await new Promise(resolve => setTimeout(resolve, STEP_IDLE_MS * 2))
      await tool({})
      yield { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1' }] } }
      yield* answer('다 됐어요.')
    }])
    const pool = new SessionPool()
    try {
      const turn = pool.run(toolJob(runs), spec(sdk))
      await vi.advanceTimersByTimeAsync(STEP_IDLE_MS * 7)
      expect((await turn).answer).toBe('다 됐어요.')
      expect(interruptions()).toBe(0)
      expect(runs.n).toBe(1)
    } finally { pool.closeAll() }
  })
  it('"멈춰" during the retried step ends the turn at once', async () => {
    vi.useFakeTimers()
    const stop = new AbortController()
    const { sdk } = scriptedSdk([
      async function* ({ interrupted }) { await interrupted; yield { type: 'result', subtype: 'error_during_execution' } },
      async function* ({ interrupted }) { await interrupted; yield { type: 'result', subtype: 'error_during_execution' } },
    ])
    const pool = new SessionPool()
    try {
      const turn = pool.run(toolJob({ n: 0 }, { signal: stop.signal }), spec(sdk))
      await vi.advanceTimersByTimeAsync(STEP_IDLE_MS + 1000)
      let done = false
      void turn.then(() => { done = true })
      stop.abort()
      await vi.advanceTimersByTimeAsync(10)
      expect(done).toBe(true)
      expect((await turn).error).toBe('canceled')
    } finally { pool.closeAll() }
  })
})
