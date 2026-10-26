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

it.each([undefined, null, {}])('keeps other frames and an incomplete fault when a frame returns %j', async value => {
  const missing = { evaluate: vi.fn().mockResolvedValue(value) }
  const reading: FrameReading = { text: 'Available frame', hidden: '', dialog: '', hasPasswordField: false,
    controls: [{ kind: 'button', name: 'Details', state: '' }], links: [], faults: [],
  }
  const present = { evaluate: vi.fn().mockResolvedValue(reading), name: () => 'Available', url: () => 'https://example.test' }
  const page = { on: vi.fn(), mainFrame: () => missing, frames: () => [missing, present] } as unknown as Page
  const result = await readFrames(page)
  expect(result.text).toBe('Available frame')
  expect(result.faults).toEqual([expect.stringContaining('extract is incomplete')])
  expect(placeOf(page, 1)?.control).toContain('Details')
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

it('keeps waiting past the first limit while the page is still fetching its own parts, and no longer once they stop', async () => {
  const page = clockPage()
  // Parts keep arriving until 17s, the words land at 18s.
  Object.assign(page, { evaluate: async () => Math.floor(Math.min(Date.now(), 17_000) / 500) })
  const slow = await readWhenReady(page, async () => ({ url: 'https://app.test', title: 'App', text: Date.now() < 18_000 ? '' : 'Popular this week' }))
  expect(slow.text).toBe('Popular this week')

  const stalled = clockPage()
  Object.assign(stalled, { evaluate: async () => Math.floor(Math.min(Date.now(), 3_000) / 500) })
  await expect(readWhenReady(stalled, async () => ({ url: 'https://app.test', title: 'App', text: '' }))).rejects.toThrow('Do not infer that it is empty')
  expect(Date.now()).toBeLessThan(15_000)

  const building = clockPage()
  Object.assign(building, { evaluate: async () => Date.now() })
  await expect(readWhenReady(building, async () => ({ url: 'https://app.test', title: 'App', text: '' }))).rejects.toThrow('Do not infer that it is empty')
  expect(Date.now()).toBeLessThan(32_000)
})

it('waits past an app frame of a few buttons while the page still fetches its content, and takes a short page that is done', async () => {
  const page = clockPage()
  Object.assign(page, { evaluate: async () => Math.floor(Math.min(Date.now(), 6_000) / 500) })
  const frame = { url: 'https://app.test', title: 'App', controls: ['[1] button "Menu"', '[2] button "Search"'] }
  const built = await readWhenReady(page, async () => ({ ...frame, text: Date.now() < 6_500 ? 'Menu Search' : 'Popular this week: '.repeat(20) }))
  expect(built.text).toContain('Popular this week')

  const short = clockPage()
  Object.assign(short, { evaluate: async () => 12 })
  const done = await readWhenReady(short, async () => ({ ...frame, text: 'Saved.' }))
  expect(done.text).toBe('Saved.')
  expect(Date.now()).toBeLessThan(2_500)
})

it('preserves a confirmed login wall and respects cancellation', async () => {
  const page = clockPage()
  expect((await readWhenReady(page, async () => ({ url: 'https://example.com', title: 'Login', text: '', wall: 'login' })))).toHaveProperty('wall', 'login')
  await expect(readWhenReady(page, async () => ({ url: '', title: '', text: '' }), AbortSignal.abort())).rejects.toThrow('stopped')
})

it('says where an embedded frame could not be read without counting the page itself as unread', async () => {
  const reading: FrameReading = { text: 'Price 5,000', hidden: '', dialog: '', hasPasswordField: false, controls: [], links: [], faults: [] }
  const main = { evaluate: vi.fn().mockResolvedValue(reading), name: () => '', url: () => 'https://shop.test' }
  const ad = { evaluate: vi.fn().mockRejectedValue(new Error('frame detached')), name: () => 'ad-slot', url: () => 'https://ads.test' }
  const page = { on: vi.fn(), mainFrame: () => main, frames: () => [main, ad] } as unknown as Page
  const result = await readFrames(page)
  expect(result.faults).toEqual([])
  expect(result.text).toContain('Price 5,000')
  expect(result.text).toContain('[frame: ad-slot - could not be read')
})

it('passes over a frame that takes no room on the page without waiting for it', async () => {
  const reading: FrameReading = { text: 'Timetable', hidden: '', dialog: '', hasPasswordField: false, controls: [], links: [], faults: [] }
  const main = { evaluate: vi.fn().mockResolvedValue(reading), name: () => '', url: () => 'https://rail.test' }
  const slot = { evaluate: vi.fn(() => new Promise(() => undefined)), name: () => 'ad', url: () => 'https://ads.test',
    frameElement: async () => ({ evaluate: async () => false, dispose: async () => undefined }) }
  const page = { on: vi.fn(), mainFrame: () => main, frames: () => [main, slot] } as unknown as Page
  const result = await readFrames(page)
  expect(result.text).toBe('Timetable')
  expect(result.faults).toEqual([])
  expect(slot.evaluate).not.toHaveBeenCalled()
})
