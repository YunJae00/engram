import { afterEach, expect, it, vi } from 'vitest'
import { runToolSession, SESSION_STALL_MS } from '../src/agent-session.js'
import type { Engine, ToolSessionJob } from '../src/engine/types.js'

afterEach(() => { vi.useRealTimers() })

it('counts model tokens without a UI subscriber and does not interrupt an active tool', async () => {
  vi.useFakeTimers()
  let job!: ToolSessionJob
  let finish!: (result: { answer: string }) => void
  let finishTool!: () => void
  const engine = { id: 'claude', runTools: (next: ToolSessionJob) => { job = next; return new Promise(resolve => { finish = resolve }) } } as unknown as Engine
  const tool = { name: 'read_open_page', description: 'read', run: () => new Promise<string>(resolve => { finishTool = () => resolve('page') }) }
  const pending = runToolSession({ engine, workdir: process.cwd(), tools: [tool] } as never, 'Read')
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS - 10_000)
  job.onToken?.('Still working')
  await vi.advanceTimersByTimeAsync(20_000)
  expect(job.signal?.aborted).toBe(false)
  const reading = job.tools[0]!.run({})
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS + 10_000)
  expect(job.signal?.aborted).toBe(false)
  finishTool(); await reading
  finish({ answer: 'Read' })
  expect((await pending).incomplete).toBeUndefined()
  expect(vi.getTimerCount()).toBe(0)
})

it('ends a turn whose model has gone silent, keeping it unfinished so the task can go on', async () => {
  vi.useFakeTimers()
  let signal: AbortSignal | undefined
  const engine = {
    id: 'claude', desktopToolIsolation: true,
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() { yield { type: 'result', text: '' } },
    runTools: (job: ToolSessionJob) => new Promise(resolve => {
      signal = job.signal
      void job.tools[0]!.run({})
      job.signal?.addEventListener('abort', () => resolve({ answer: '', error: 'canceled' }), { once: true })
    }),
  } as unknown as Engine
  const tools = [{ name: 'file_create_copy', description: 'save', run: async () => JSON.stringify({ markdownLink: '[Draft](engram-artifact:draft.txt)' }) }]
  const pending = runToolSession({ engine, workdir: process.cwd(), tools } as never, 'Prepare a draft')
  await vi.advanceTimersByTimeAsync(SESSION_STALL_MS - 10_000)
  expect(signal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(20_000)
  const result = await pending
  expect(signal?.aborted).toBe(true)
  expect(result.incomplete).toContain('stopped responding')
  expect(result.answer).toContain('Not verified as complete')
  expect(result.answer).toContain('[Draft](engram-artifact:draft.txt)')
  expect(result.steps).toHaveLength(1)
})
