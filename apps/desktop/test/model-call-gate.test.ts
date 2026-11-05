import { afterEach, expect, it, vi } from 'vitest'
import type { Engine, EngineCwd } from 'core'
import { enterModelCall, gateModelCalls, holdModelTaskEngine } from '../src/main/model-call-gate.js'
import { flog } from '../src/main/flog.js'
import { modelCall, withModelCallContext } from '../src/main/model-call-metrics.js'
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
afterEach(() => vi.useRealTimers())

it('holds queued background calls across task steps and resumes after thirty idle seconds per engine', async () => {
  vi.useFakeTimers()
  let finish!: () => void
  let entered = false
  const task = withModelCallContext({ channel: 'one', purpose: 'task' }, async () => {
    holdModelTaskEngine('gate-one')
    await new Promise<void>(resolve => { finish = resolve })
  })
  await Promise.resolve()
  const background = enterModelCall('gate-one', false).then(() => { entered = true })
  await vi.advanceTimersByTimeAsync(60_000)
  expect(entered).toBe(false)
  await expect(enterModelCall('gate-two', false)).resolves.toBeTypeOf('function')
  finish(); await task
  await vi.advanceTimersByTimeAsync(29_999)
  expect(entered).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await background
  expect(entered).toBe(true)
})

it('lets an already running background call finish and cancels queued work without starting it', async () => {
  vi.useFakeTimers()
  const complete = await enterModelCall('gate-cancel', false)
  const release = await enterModelCall('gate-cancel', true)
  complete()
  const abort = new AbortController()
  const waiting = enterModelCall('gate-cancel', false, abort.signal)
  const rejected = expect(waiting).rejects.toThrow('cancelled')
  abort.abort(new Error('cancelled'))
  await rejected
  release()
})

it('labels adapter iteration and forces low effort for unlabelled maintenance work', async () => {
  const jobs: unknown[] = []
  const fake = gateModelCalls({ id: 'mock', detect: vi.fn(), async *run(job) { jobs.push(job); yield { type: 'result', text: 'ok' } } } as Engine)
  for await (const event of fake.run({ prompt: 'memory', workdir: 'tmp' as EngineCwd, effort: 'high' })) expect(event.type).toBe('result')
  expect(jobs).toEqual([expect.objectContaining({ effort: 'low' })])
})

it('emits no new background model-call starts while a human task is thinking between calls', async () => {
  vi.useFakeTimers(); vi.mocked(flog).mockClear()
  const engine = gateModelCalls({ id: 'mock', detect: vi.fn(), async *run() {
    modelCall('mock', 1, 'low').end(); yield { type: 'result', text: 'ok' }
  } } as Engine)
  const job = { prompt: 'test', workdir: 'tmp' as EngineCwd }
  const consume = async () => { for await (const event of engine.run(job)) expect(event.type).toBe('result') }
  let finish!: () => void
  const task = withModelCallContext({ channel: 'human', purpose: 'task' }, async () => {
    await consume()
    await new Promise<void>(resolve => { finish = resolve })
    await consume()
  })
  await vi.advanceTimersByTimeAsync(1)
  const pending = withModelCallContext({ channel: 'background', purpose: 'habit-drafts' }, consume)
  await vi.advanceTimersByTimeAsync(60_000)
  const starts = () => vi.mocked(flog).mock.calls.map(([, line]) => JSON.parse(String(line))).filter(row => row.phase === 'start')
  expect(starts().filter(row => row.purpose !== 'task')).toHaveLength(0)
  finish(); await task
  await vi.advanceTimersByTimeAsync(30_000); await pending
  expect(starts().map(row => row.purpose)).toEqual(['task', 'task', 'habit-drafts'])
})
