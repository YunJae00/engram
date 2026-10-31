import { expect, it, vi } from 'vitest'
import { runToolSession, type Engine, type EngineCwd, type ToolSessionJob } from 'core'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { SessionPool, type SessionSdk } from '../src/main/engine-claude-session.js'
import { claudeTokenUsage } from '../src/main/claude-token-usage.js'

const start = (id: string, input: number, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_start', message: { id, usage: { input_tokens: input, output_tokens: 2, cache_read_input_tokens: 20 } } } })
const delta = (output: number, parent: string | null = null) => ({ type: 'stream_event', parent_tool_use_id: parent, event: { type: 'message_delta', usage: { output_tokens: output } } })
const result = (input: number, output: number, cache = 20) => ({ type: 'result', subtype: 'success', result: 'Done', modelUsage: { model: { inputTokens: input, outputTokens: output, cacheReadInputTokens: cache, cacheCreationInputTokens: 0 } } })

function fixture(turns: unknown[][]) {
  const interrupt = vi.fn(async () => {})
  const sdk: SessionSdk = {
    tool: () => ({}), createSdkMcpServer: () => ({}),
    query: ({ prompt, options }) => Object.assign((async function* () {
      let turn = 0
      for await (const input of prompt) {
        expect(input.type).toBe('user')
        for (const message of turns[turn++] ?? []) {
          if ((options?.['abortController'] as AbortController).signal.aborted) return
          yield message as { type: string }
        }
      }
    })(), { interrupt, supportedModels: async () => [] }),
  }
  const pool = new SessionPool()
  const run = (job: ToolSessionJob) => pool.run(job, { sdk, binary: 'fixture', workdir: 'tmp', model: 'fixture' })
  return { pool, run, interrupt }
}

it('counts streamed deltas and cumulative results once across warm turns', async () => {
  const f = fixture([
    [start('a', 100), delta(5), delta(5), { type: 'assistant', message: { id: 'a', usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 20 }, content: [] } }, result(110, 5)],
    [start('b', 30), result(140, 7, 40)],
    [result(150, 10, 40)],
  ])
  const onUsage = vi.fn()
  const job: ToolSessionJob = { workdir: 'tmp' as EngineCwd, system: '', prompt: 'Work', tools: [], maxCalls: 10, onUsage }
  try {
    await f.run(job)
    expect(onUsage.mock.calls.flat()).toEqual([122, 3, 10])
    onUsage.mockClear()
    await f.run(job)
    expect(onUsage.mock.calls.flat()).toEqual([52])
    onUsage.mockClear()
    await f.run(job)
    expect(onUsage.mock.calls.flat()).toEqual([13])
  } finally { f.pool.closeAll() }
})

it('interrupts the Claude stream as soon as reported usage exhausts the task budget', async () => {
  const f = fixture([[start('a', 100), delta(35), result(999, 999)]])
  const onUsage = vi.fn()
  try {
    const engine = { id: 'claude', runTools: f.run } as unknown as Engine
    const output = await runToolSession({ engine, workdir: 'tmp' as EngineCwd, tools: [] }, 'Work', { tokenBudget: 150, onUsage })
    expect(onUsage.mock.calls.flat()).toEqual([122, 33])
    expect(output).toMatchObject({ budgetExhausted: true, tokensUsed: 155 })
    expect(output.answer).toContain('150 tokens available for this turn')
    expect(f.interrupt).toHaveBeenCalledOnce()
  } finally { f.pool.closeAll() }
})

it('ignores invalid and regressing counts and isolates interleaved subagent streams', () => {
  const usage = claudeTokenUsage()
  expect(usage(start('a', 100))).toBe(122)
  expect(usage(start('b', 10, 'tool-1'))).toBe(32)
  expect(usage(delta(5))).toBe(3)
  expect(usage(delta(4, 'tool-1'))).toBe(2)
  for (const invalid of [-1, NaN, Infinity, 2.5, 1]) expect(usage(delta(invalid))).toBe(0)
  expect(usage(delta(8))).toBe(3)
  expect(usage(result(-1, 10))).toBe(0)
  expect(usage({ type: 'result', subtype: 'success' })).toBe(0)
  expect(usage({ type: 'result', usage: { input_tokens: 10, output_tokens: 2 } })).toBe(12)
})
