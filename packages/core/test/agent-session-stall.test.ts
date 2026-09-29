import { afterEach, expect, it, vi } from 'vitest'
import { runToolSession, SESSION_STALL_MS } from '../src/agent-session.js'
import type { Engine, ToolSessionJob } from '../src/engine/types.js'

afterEach(() => { vi.useRealTimers() })

it('ends a turn whose model has gone silent, keeping it unfinished so the task can go on', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  const engine = {
    id: 'claude', desktopToolIsolation: true,
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() { yield { type: 'result', text: '' } },
    runTools: (job: ToolSessionJob) => new Promise(resolve => {
      signal = job.signal
      job.signal?.addEventListener('abort', () => resolve({ answer: '', error: 'canceled' }), { once: true })
    }),
  } as unknown as Engine
  const pending = runToolSession({ engine, workdir: process.cwd(), tools: [] } as never, 'Enter today\'s hours')
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS - 10_000)
  expect(signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(20_000)
  const result = await pending
  expect(signal?.aborted).toBe(true)
  expect(result.incomplete).toContain('stopped responding')
  expect(result.answer).toContain('Not verified as complete')
})
