import { mkdir, mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ data: '', capture: vi.fn(), sweep: vi.fn(), state: vi.fn(), absorb: vi.fn() }))
vi.mock('core', async original => ({
  ...await original<typeof import('core')>(),
  processCapture: fake.capture, sweep: fake.sweep, loadState: fake.state, loadAbsorbState: fake.absorb,
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => fake.data },
  BrowserWindow: { getAllWindows: () => [] }, ipcMain: { handle: vi.fn() }, shell: {},
}))
vi.mock('../src/main/session-context.js', () => ({ syncSessionContext: vi.fn(async () => undefined) }))
import { engineBackoff, guideNote, type RunReport } from 'core'
import { isLibrarianBusy, runPipelineAsync, scheduleAutoTidy } from '../src/main/ipc.js'
import type { VaultContext } from '../src/main/vault.js'

const report: RunReport = { executed: 0, skipped: 0, deferred: 0, failed: [] }
const releases: Array<() => void> = []
let ctx: VaultContext

function hold<T>(value: T) {
  let finish!: () => void
  const promise = new Promise<T>(resolve => { finish = () => resolve(value) })
  releases.push(finish)
  return { promise, finish }
}

beforeEach(async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  fake.data = await mkdtemp(resolve('tmp/filing-scheduling-'))
  const inbox = join(fake.data, 'inbox')
  await mkdir(inbox)
  vi.stubEnv('ENGRAM_USERDATA', fake.data)
  vi.stubEnv('ENGRAM_VAULT', fake.data)
  vi.stubEnv('ENGRAM_NO_AUTOTIDY', '0')
  vi.stubEnv('ENGRAM_ENGINE', 'none')
  engineBackoff.noteOk()
  fake.capture.mockReset().mockResolvedValue(report)
  fake.sweep.mockReset().mockResolvedValue(report)
  fake.state.mockReset().mockResolvedValue({})
  fake.absorb.mockReset().mockResolvedValue({ pending: [], total: 0 })
  ctx = {
    paths: { inbox }, git: null, engines: [{ id: 'mock' }],
    store: { getAll: () => [guideNote('## Rules\n- Ask before sending', new Date())] },
  } as unknown as VaultContext
  vi.useFakeTimers()
  vi.spyOn(globalThis, 'setTimeout')
})

afterEach(async () => {
  for (const finish of releases.splice(0)) finish()
  await vi.waitFor(() => expect(isLibrarianBusy()).toBe(false))
  vi.clearAllTimers()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  engineBackoff.noteOk()
})

it('defers an immediate tidy while a capture is already filing', async () => {
  const pending = hold(report)
  fake.capture.mockReturnValueOnce(pending.promise)
  runPipelineAsync(ctx, 'capture')
  expect(fake.capture).toHaveBeenCalledOnce()
  scheduleAutoTidy(ctx, 0)
  await vi.advanceTimersByTimeAsync(0)
  await vi.waitFor(() => expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 600_000))
  expect(fake.sweep).not.toHaveBeenCalled()
  expect(isLibrarianBusy()).toBe(true)
})

it('leaves a new capture for the next tidy when a sweep already owns filing', async () => {
  const pending = hold({ ...report, executed: 1 })
  fake.sweep.mockReturnValueOnce(pending.promise)
  scheduleAutoTidy(ctx, 0)
  await vi.advanceTimersByTimeAsync(0)
  await vi.waitFor(() => expect(fake.sweep).toHaveBeenCalledOnce())
  runPipelineAsync(ctx, 'capture during sweep')
  expect(fake.capture).not.toHaveBeenCalled()
  expect(isLibrarianBusy()).toBe(true)
  pending.finish()
  await vi.waitFor(() => expect(isLibrarianBusy()).toBe(false))
  await vi.advanceTimersByTimeAsync(90_000)
  await vi.waitFor(() => expect(fake.sweep).toHaveBeenCalledTimes(2))
  expect(fake.capture).not.toHaveBeenCalled()
})

it('checks filing ownership again after reading pending work', async () => {
  const state = hold({}), capture = hold(report)
  fake.state.mockReturnValueOnce(state.promise)
  fake.capture.mockReturnValueOnce(capture.promise)
  scheduleAutoTidy(ctx, 0)
  await vi.advanceTimersByTimeAsync(0)
  await vi.waitFor(() => expect(fake.state).toHaveBeenCalledOnce())
  runPipelineAsync(ctx, 'capture while pending work is read')
  expect(fake.capture).toHaveBeenCalledOnce()
  state.finish()
  await vi.waitFor(() => expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 600_000))
  expect(fake.sweep).not.toHaveBeenCalled()
})
