import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EngineCwd, ToolSessionJob } from 'core'
const logged = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: logged }))
import { askNow, checkedDesk, onlyAsked, reshapePrompt, routeAsk, shareReady, withOffer } from '../src/main/desk-lane.js'
import { turnRunning, yielding } from '../src/main/comet-memory.js'
import { SessionPool, STEP_IDLE_MS, type SdkUserMessage, type SessionSdk } from '../src/main/engine-claude-session.js'
import { checkPrompt } from '../../../packages/core/src/written-check.js'

const ipc = readFileSync(join(__dirname, '../src/main/ipc.ts'), 'utf8')

// c17b (cause C, H2 class): a correction takes the earlier ask's route, but every check reads what the person wants now.
// Wordings are not the harness's: an inventory quarter, a branch city.
describe('a correction is checked against the ask as the person changed it', () => {
  const earlier = [{ role: 'user', text: 'inventory.csv에서 3분기 입고 수량 알려줘' }, { role: 'assistant', text: '3분기 입고 수량은 1,240개예요.' }]
  const message = '아니 그거 말고 2분기로'
  // A stand-in check model that reads the ask the way the prompt says: the later words hold where the two differ.
  const quarterAsked = (prompt: string): string => {
    const asked = /The person asked: (.*)/.exec(prompt)![1]!
    const later = /changed it: \\"([^\\]*)\\"/.exec(asked)?.[1] ?? asked
    return /(\d)분기/.exec(later)?.[1] ?? /(\d)분기/.exec(asked)![1]!
  }
  const fakeCheck = (prompt: string): string => {
    const draft = /Message: (.*)/.exec(prompt)![1]!
    return /(\d)분기/.exec(draft)![1] === quarterAsked(prompt) ? '{"problems":[]}' : JSON.stringify({ problems: [{ kind: 'contradicts', quote: draft, why: '다른 분기' }] })
  }
  it('routes by the earlier ask, means the earlier ask with the later words holding', () => {
    expect(routeAsk(message, earlier)).toBe('inventory.csv에서 3분기 입고 수량 알려줘')
    const meant = askNow(message, earlier)
    expect(meant).toContain('inventory.csv에서 3분기 입고 수량 알려줘')
    expect(meant).toContain('The person then changed it: "아니 그거 말고 2분기로". Where the two differ, the later words hold.')
    // Not a correction: the message itself.
    expect(askNow('inventory.csv 품목 수 알려줘', earlier)).toBe('inventory.csv 품목 수 알려줘')
  })
  it('a 2분기 draft is not called "contradicts", and is delivered as written', async () => {
    const prompts: string[] = []
    const draft = '2분기 입고 수량은 980개예요.'
    const out = await checkedDesk({ ask: askNow(message, earlier), draft, source: '분기,입고\n2,980\n3,1240', fromSource: true, quick: async p => { prompts.push(p); return fakeCheck(p) }, since: Date.now() })
    expect(out).toBe(draft)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('2분기')
    // The route text alone (the H2 bug) makes the same check call the right draft wrong.
    expect(fakeCheck(checkPrompt({ data: {}, ask: routeAsk(message, earlier), parts: true }, draft))).toContain('contradicts')
  })
  it('a check rewrite reads the later words too, so it cannot put 3분기 back', async () => {
    const prompts: string[] = []
    const said = [JSON.stringify({ problems: [{ kind: 'missing', quote: '입고 수량', why: '' }] })]
    const out = await checkedDesk({
      ask: askNow(message, earlier), draft: '2분기는 980개예요.', source: '분기,입고\n2,980\n3,1240', fromSource: true, since: Date.now(),
      // The rewriter writes the quarter its prompt says the person wants now.
      // c18b: the one repair is scoped (core repairedWrite): a missing part is added as a line, from the quarter its prompt says is wanted now.
      quick: async p => { prompts.push(p); return p.startsWith('You fix a message') ? JSON.stringify({ insert_after: { 1: [`${quarterAsked(p)}분기 입고 수량은 ${quarterAsked(p) === '2' ? '980' : '1,240'}개예요.`] } }) : said.shift() ?? fakeCheck(p) },
    })
    expect(out).toContain('2분기 입고 수량은 980개예요.')
    expect(out).not.toContain('3분기')
    expect(prompts.find(p => p.startsWith('You fix a message'))).toContain('Where the two differ, the later words hold.')
  })
  it('the filters and the offer read the corrected meaning', () => {
    const before = [{ role: 'user', text: 'notes/branch-sync.md에서 서울 지점 할 일만 뽑아줘' }, { role: 'assistant', text: '- 김하늘: 재고 점검 — 12월 2일' }]
    const meant = askNow('그냥 부산 걸로 바꿔', before)
    expect(meant).toContain('"그냥 부산 걸로 바꿔"')
    const answer = '할 일\n- 이도윤: 매장 점검 — 12월 3일\n- 정수아: 발주 정리 — 12월 5일\n\n미결\n- 휴무일 조정'
    // r2: the host cannot tell which earlier words a correction withdrew, so its cut runs only on the correction's own words; the model keeps the rest.
    expect(onlyAsked(meant, answer)).toBe(answer)
    expect(withOffer(meant, '- 이도윤: 매장 점검 — 12월 3일', [], true)).toMatch(/원하시면 담당자별로 보낼 알림 문구도 써 드릴게요\.$/)
  })
  // c17b r2 (Codex r1): wordings not in the harness: a branch's open questions, a reading list.
  it('a correction that widens the ask keeps what the earlier narrowing word would have cut', () => {
    const before = [{ role: 'user', text: 'docs/branch-week.md에서 할 일만 추려줘' }, { role: 'assistant', text: '- 재고 점검' }]
    const answer = '할 일\n- 재고 점검\n\n미결\n- 휴무일 조정'
    for (const widen of ['아니 그거 말고 다 보여줘', '음 그거 말고 미결까지 같이']) expect(onlyAsked(askNow(widen, before), answer)).toBe(answer)
    // A correction that narrows in its own words still cuts.
    expect(onlyAsked(askNow('아 그거 말고 할 일만 다시', [{ role: 'user', text: 'docs/branch-week.md 요약해줘' }]), answer)).toBe('- 재고 점검')
    // Not a correction: unchanged behavior.
    expect(onlyAsked('docs/branch-week.md에서 할 일만 추려줘', answer)).toBe('- 재고 점검')
  })
  // c17b r3 (Codex r2): a later correction withdraws an earlier correction's narrowing. Wordings not in the harness.
  it('along a chain, only the latest correction narrows', () => {
    const answer = '할 일\n- 발주 확인\n\n미결\n- 회식 날짜'
    const chain = [{ role: 'user', text: 'memo/store-plan.md 정리해줘' }, { role: 'user', text: '아 그거 말고 할 일만' }]
    for (const widen of ['아니 그거 말고 전부 다', '음 그거 말고 처음처럼']) {
      expect(onlyAsked(askNow(widen, chain), answer)).toBe(answer)
      expect(onlyAsked(askNow('그거 말고 다 줘', [...chain, { role: 'user', text: widen }]), answer)).toBe(answer)
    }
    // Narrowing said again last still cuts, whatever came between.
    expect(onlyAsked(askNow('아니 그거 말고 할 일만 줘', [...chain, { role: 'user', text: '음 그거 말고 전체로' }]), answer)).toBe('- 발주 확인')
    // shareReady follows the same rule: an earlier "공유하기 좋게" withdrawn by a later correction no longer trims.
    const notes = '일시: 12월 1일\n\n할 일\n- 발주 확인'
    expect(shareReady(askNow('그거 말고 원래대로', [{ role: 'user', text: 'memo/a.md 요약해줘' }, { role: 'user', text: '아 그거 말고 공유하기 좋게' }]), notes)).toBe(notes)
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
    // An ask after the chain that is not a correction starts a new route.
    expect(routeAsk('아 그거 말고 장르별로', [...turns, { role: 'user', text: 'notes/plan.md 요약해줘' }])).toBe('notes/plan.md 요약해줘')
  })
  it('every check, rewrite, filter and offer in the turn reads the meaning; the route alone decides the lane', () => {
    for (const use of ['withoutSameDecisions(meant,', 'shareReady(meant,', 'onlyAsked(meant,', 'tidyCounts(meant,', 'withOffer(meant,', 'ask: meant, draft: result.answer', 'namedText(meant,']) expect(ipc).toContain(use)
    const routedUses = ipc.split('\n').filter(line => /\brouted\b/.test(line) && !line.trim().startsWith('//'))
    for (const line of routedUses) expect(line).toMatch(/const routed = routeAsk|fastLane\(routed|deskLane\(routed|deskKind\(routed|routed === request\.message|deskLight\(kind, routed/)
    expect(ipc).toContain('What the person asks for now: ${meant}')
  })
  it('a reshape and the rewrite check keep a changed fact at its new value', () => {
    expect(reshapePrompt('더 짧게', '부산 지점 할 일은 두 개예요.', '서울 지점 할 일 알려줘')).toContain('A fact the person has since changed in this conversation takes its new value.')
    expect(checkPrompt({ data: {}, ask: '더 짧게', rewrite: true }, 'x')).toContain('A fact the person has since changed takes its new value')
  })
})

// c17b (cause W a, D2/D3 class): background memory waits for the whole person's turn, not only its start.
describe('memory waits while a person\'s turn runs', () => {
  const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))
  it('a slow memory call queued between the turn\'s tools does not run next to the turn, and completes after release', async () => {
    const release = turnRunning()
    let started = 0
    const memory = yielding(async () => { started = Date.now(); await tick(30); return 'kept' }, undefined, true)
    // The turn's next step: it is not slowed and nothing runs beside it.
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

// c17b (cause W b, D2 class): a step that streams nothing is cut and asked again once; slow thinking and long tools are not cut.
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
