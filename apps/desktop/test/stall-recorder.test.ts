import { afterEach, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
const fake = vi.hoisted(() => ({ write: vi.fn(), log: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => 'fixture' } }))
vi.mock('node:fs/promises', () => ({ writeFile: fake.write, readdir: async () => [], rm: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: fake.log }))
import { recordStalls } from '../src/main/stall-recorder.js'

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks() })
it('keeps the preceding profile when a stall is reported after rotation', async () => {
  vi.useFakeTimers()
  vi.stubEnv('ENGRAM_STALL_PROFILE', '1')
  let sample = 0
  const sendCommand = vi.fn(async (command: string) => command === 'Profiler.stop' ? { profile: { sample: ++sample } } : {})
  const contents = { debugger: { attach: vi.fn(), isAttached: () => true, sendCommand, once: vi.fn() }, isDestroyed: () => false, once: vi.fn() } as unknown as WebContents
  const report = recordStalls(contents)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fake.write).not.toHaveBeenCalled()
  report(3_000)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fake.write.mock.calls.map(call => call[1])).toEqual(['{"sample":1}', '{"sample":2}'])
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fake.write).toHaveBeenCalledTimes(2)
})
