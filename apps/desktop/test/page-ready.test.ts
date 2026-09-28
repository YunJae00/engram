import { afterEach, expect, it, vi } from 'vitest'
import type { Page } from 'playwright-core'
import { readWhenReady } from '../src/main/page-ready.js'
import { readFrames, placeOf, type FrameReading } from '../src/main/page-reader.js'

afterEach(() => vi.restoreAllMocks())

it('marks unreadable frames as incomplete instead of silently claiming a full page read', async () => {
  const frame = { evaluate: vi.fn().mockRejectedValue(new Error('frame detached')) }
  const page = { on: vi.fn(), mainFrame: () => frame, frames: () => [frame] } as unknown as Page
  expect((await readFrames(page)).faults).toEqual([expect.stringContaining('extract is incomplete')])
})

it('does not let a canceled frame read overwrite newer control references', async () => {
  const snapshot = (name: string): FrameReading => ({ text: name, hidden: '', hasPasswordField: false, links: [], controls: [{ kind: 'button', name, state: '' }], dialog: '', faults: [] })
  let finish!: (value: FrameReading) => void
  const frame = { evaluate: vi.fn().mockImplementationOnce(() => new Promise<FrameReading>(r => { finish = r })).mockResolvedValue(snapshot('Current')), name: () => '', url: () => 'https://example.test' }
  const page = { on: vi.fn(), mainFrame: () => frame, frames: () => [frame] } as unknown as Page
  const controller = new AbortController()
  const old = readFrames(page, controller.signal)
  controller.abort()
  await readFrames(page)
  finish(snapshot('Obsolete'))
  await expect(old).rejects.toThrow()
  expect(placeOf(page, 1)?.control).toContain('Current')
})

it('times out a hung read and stops polling even if it resolves late', async () => {
  vi.useFakeTimers()
  try {
    let resolve!: (value: { url: string; title: string; text: string }) => void
    const read = vi.fn(() => new Promise<{ url: string; title: string; text: string }>(r => { resolve = r }))
    const page = { waitForTimeout: vi.fn() } as unknown as Page
    const result = expect(readWhenReady(page, read)).rejects.toThrow('45 seconds')
    await vi.advanceTimersByTimeAsync(45_000)
    await result
    resolve({ url: 'https://example.test', title: '', text: '' })
    await vi.advanceTimersByTimeAsync(1)
    expect(read).toHaveBeenCalledTimes(1)
    expect(page.waitForTimeout).not.toHaveBeenCalled()
  } finally { vi.useRealTimers() }
})

it('cancels a hung read immediately', async () => {
  const controller = new AbortController()
  const read = vi.fn(() => new Promise<never>(() => {}))
  const result = readWhenReady({} as Page, read, controller.signal)
  controller.abort()
  await expect(result).rejects.toThrow('stopped')
})

function clockPage() {
  let now = 0
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  return { waitForTimeout: async (ms: number) => { now += ms } } as unknown as Page
}

it('waits for delayed content rather than returning a blank page', async () => {
  const page = clockPage()
  let reads = 0
  const result = await readWhenReady(page, async () => { reads++; return { url: 'https://example.com', title: 'App', text: Date.now() < 4400 ? '' : 'Report ready' } })
  expect(result.text).toBe('Report ready')
  expect(reads).toBeLessThan(8)
  expect(Date.now()).toBeGreaterThanOrEqual(4400)
})

it('bounds empty page recovery and never declares missing content as a fact', async () => {
  const page = clockPage()
  await expect(readWhenReady(page, async () => ({ url: 'https://example.com', title: 'App', text: '' }))).rejects.toThrow('Do not infer that it is empty')
})

it('preserves a confirmed login wall and respects cancellation', async () => {
  const page = clockPage()
  expect((await readWhenReady(page, async () => ({ url: 'https://example.com', title: 'Login', text: '', wall: 'login' })))).toHaveProperty('wall', 'login')
  await expect(readWhenReady(page, async () => ({ url: '', title: '', text: '' }), AbortSignal.abort())).rejects.toThrow('stopped')
})
