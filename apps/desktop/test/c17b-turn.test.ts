import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineCwd, ToolSessionJob } from 'core'
const logged = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: logged }))
import * as desk from '../src/main/desk-lane.js'
import { askNow, closingBuilds, routeAsk } from '../src/main/desk-lane.js'
import { turnRunning, yielding } from '../src/main/comet-memory.js'
import { SessionPool, STEP_IDLE_MS, type SdkUserMessage, type SessionSdk } from '../src/main/engine-claude-session.js'
import { COLLEAGUE_CORE_RULE, FILE_JOB_RULE } from '../../../packages/core/src/agent-voice.js'

const ipc = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')

describe('a correction is checked against the ask as the person changed it', () => {
  const earlier = [{ role: 'user', text: 'inventory.csv에서 3분기 입고 수량 알려줘' }, { role: 'assistant', text: '3분기 입고 수량은 1,240개예요.' }]
  const message = '아니 그거 말고 2분기로'
  const HOLDS = 'Where the two differ, the later words hold.'
  it('routes by the earlier ask, means the earlier ask with the later words holding', () => {
    expect(routeAsk(message, earlier)).toBe('inventory.csv에서 3분기 입고 수량 알려줘')
    const meant = askNow(message, earlier)
    expect(meant).toContain('inventory.csv에서 3분기 입고 수량 알려줘')
    expect(meant).toContain('The person then changed it: "아니 그거 말고 2분기로". Where the two differ, the later words hold.')
    expect(askNow('inventory.csv 품목 수 알려줘', earlier)).toBe('inventory.csv 품목 수 알려줘')
  })
  it('a 2분기 reply written with a build closes the turn exactly as the model wrote it', async () => {
    const draft = '2분기 입고 수량은 980개예요.\n\n표로도 넣어 뒀어요.'
    const receipt = JSON.stringify({ markdownLink: '[입고-2분기.xlsx](engram-artifact:stock-q2.xlsx)' })
    const seen: Record<string, unknown>[] = []
    const made = (): ReturnType<typeof closingBuilds>[number] => closingBuilds([{ name: 'file_create_workbook', description: '', argsSchema: { type: 'object', properties: {}, required: [] }, run: async args => { seen.push(args); return receipt } }])[0]!
    const build = made(), silent = made()
    const out = await build.run({ name: '입고-2분기.xlsx', reply: draft, more: false }, { task: askNow(message, earlier) })
    expect(build.closesOn!(out)).toBe(true)
    expect(build.closeAnswer!(out)).toBe(draft)
    expect(seen).toEqual([{ name: '입고-2분기.xlsx' }])
    expect(silent.closesOn!(await silent.run({ name: '입고-2분기.xlsx', more: false }, { task: '' }))).toBe(false)
  })
  it('no check or rewrite stands between the draft and the person, so the later words reach the model itself', () => {
    for (const gone of ['checkedDesk', 'reshapePrompt', 'reshapeAsk', 'onlyAsked', 'shareReady', 'withOffer', 'withoutSameDecisions', 'tidyCounts']) { expect(Object.keys(desk)).not.toContain(gone); expect(ipc).not.toContain(`${gone}(`) }
    expect(askNow(message, earlier)).toContain(HOLDS)
    expect(ipc).toContain('const changedNote = meant !== request.message ? `What the person asks for now: ${meant}` : \'\'')
    expect(ipc).toMatch(/attachmentContext: \[[^\]]*changedNote[^\]]*\]/)
    expect(COLLEAGUE_CORE_RULE).toContain('Your reply reaches the person exactly as you write it, so write it finished: nobody tidies, checks or completes it after you.')
  })
  it('the corrected meaning names the new part, and the rules for one part and one offer are the model\'s', () => {
    const before = [{ role: 'user', text: 'notes/branch-sync.md에서 서울 지점 과제만 골라줘' }, { role: 'assistant', text: '- 김하늘: 재고 점검 — 12월 2일' }]
    const meant = askNow('그냥 부산 걸로 바꿔', before)
    expect(meant).toContain('"그냥 부산 걸로 바꿔"')
    expect(meant).toContain('notes/branch-sync.md에서 서울 지점 과제만 골라줘')
    expect(COLLEAGUE_CORE_RULE).toContain('When they ask for one part of something, give that part only.')
    expect(FILE_JOB_RULE).toContain('ends with exactly ONE short offer line of something new that would really help')
  })
  it('a correction that widens the ask reaches the model with the earlier narrowing word and the widening after it', () => {
    const before = [{ role: 'user', text: 'docs/branch-week.md에서 할 일만 추려줘' }, { role: 'assistant', text: '- 재고 점검' }]
    for (const widen of ['아니 그거 말고 다 보여줘', '음 그거 말고 미결까지 같이']) {
      const meant = askNow(widen, before)
      expect(meant.indexOf('할 일만 추려줘')).toBeGreaterThan(-1)
      expect(meant.indexOf(`"${widen}"`)).toBeGreaterThan(meant.indexOf('할 일만 추려줘'))
      expect(meant).toContain(HOLDS)
    }
    expect(askNow('아니 그거 말고 과제만 다시', [{ role: 'user', text: 'docs/branch-week.md 간추려줘' }])).toContain('"아니 그거 말고 과제만 다시"')
    expect(askNow('docs/branch-week.md에서 과제만 추려줘', [])).toBe('docs/branch-week.md에서 과제만 추려줘')
  })
  it('along a chain, every correction is given in order and the latest one is last', () => {
    const chain = [{ role: 'user', text: 'memo/store-plan.md 정리해줘' }, { role: 'user', text: '아니 그거 말고 과제만' }]
    for (const widen of ['아니 그거 말고 전부 다', '음 그거 말고 처음처럼']) {
      const meant = askNow(widen, chain)
      expect(meant).toContain(`"아니 그거 말고 과제만", then "${widen}". Where they differ, the later words hold.`)
      expect(askNow('그거 말고 다 줘', [...chain, { role: 'user', text: widen }])).toContain(`"아니 그거 말고 과제만", then "${widen}", then "그거 말고 다 줘".`)
    }
    expect(askNow('아니 그거 말고 과제만 줘', [...chain, { role: 'user', text: '음 그거 말고 전체로' }])).toMatch(/then "아니 그거 말고 과제만 줘"\. Where they differ, the later words hold\.$/)
    expect(routeAsk('그거 말고 원래대로', [{ role: 'user', text: 'memo/a.md 간추려줘' }, { role: 'user', text: '아니 그거 말고 돌려보기 편하게' }])).toBe('memo/a.md 간추려줘')
  })
  it('successive corrections keep the original task as the route and every change in the meaning, oldest first', () => {
    const turns = [
      { role: 'user', text: 'reading/list.md에서 이번 달 읽을 책만 골라줘' }, { role: 'assistant', text: '- 책 A' },
      { role: 'user', text: '아 그거 말고 전부로' }, { role: 'assistant', text: '- 책 A\n- 책 B' },
      { role: 'user', text: '아니 그거 말고 저자별로' }, { role: 'assistant', text: '…' },
    ]
    const third = '음 그거 말고 출판연도순으로'
    expect(routeAsk(third, turns)).toBe('reading/list.md에서 이번 달 읽을 책만 골라줘')
    const meant = askNow(third, turns)
    expect(meant).toContain('changed it: "아 그거 말고 전부로", then "아니 그거 말고 저자별로", then "음 그거 말고 출판연도순으로". Where they differ, the later words hold.')
    expect(routeAsk('아 그거 말고 장르별로', [...turns, { role: 'user', text: 'notes/plan.md 요약해줘' }])).toBe('notes/plan.md 요약해줘')
  })
  it('the model reads the meaning in its turn context and the named file; the route alone decides the lane', () => {
    for (const use of ['namedText(meant,', 'namedBy(meant, path)', 'const meant = askNow(request.message, savedHistory)']) expect(ipc).toContain(use)
    const routedUses = ipc.split('\n').filter(line => /\brouted\b/.test(line) && !line.trim().startsWith('//'))
    for (const line of routedUses) expect(line).toMatch(/const routed = routeAsk|fastLane\(routed|deskLane\(routed|deskKind\(routed|routed === request\.message|deskLight\(kind, routed/)
    expect(ipc).toContain('What the person asks for now: ${meant}')
    expect(ipc).toMatch(/await deliverAnswer\(\s*`\$\{result\.asked \? askText\(result\.answer, result\.options\) : result\.answer\}\$\{note\}`/)
  })
  it('a reshape keeps every fact and constraint, and a changed fact is the model\'s to carry', () => {
    expect(COLLEAGUE_CORE_RULE).toContain('write that reply again in the asked form with every fact and every constraint of the original ask kept, and nothing about what you changed.')
    expect(COLLEAGUE_CORE_RULE).toContain('means do the new thing at once - never ask which one they mean when the thread already says it')
    expect(askNow('더 짧게', [{ role: 'user', text: '서울 지점 할 일 알려줘' }, { role: 'assistant', text: '부산 지점 할 일은 두 개예요.' }])).toBe('더 짧게')
  })
})

describe('memory waits while a person\'s turn runs', () => {
  const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
  it('a slow memory call queued between the turn\'s tools does not run next to the turn, and completes after release', async () => {
    const release = turnRunning()
    let started = 0
    const memory = yielding(async () => { started = Date.now(); await tick(30); return 'kept' }, undefined, true)
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
  it('a "keep this" fact is never dropped by busy turns and is kept once they end', async () => {
    let runs = 0
    const memory = yielding(signal => new Promise<string>((resolve, reject) => { runs++; if (runs > 5) return resolve('the fact'); signal.addEventListener('abort', () => reject(new Error('cut'))) }), undefined, true)
    for (let i = 0; i < 5; i++) { await tick(); turnRunning()() }
    expect(await memory).toBe('the fact')
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
