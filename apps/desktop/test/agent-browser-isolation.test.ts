import { EventEmitter } from 'node:events'
import type { Page } from 'playwright-core'
import { afterEach, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ open: vi.fn(), create: vi.fn(), close: vi.fn(async () => {}) }))
vi.mock('../src/main/native-browser.js', () => ({
  nativeBrowserEnabled: () => true, isNativeContext: () => true, isNativePage: () => true,
  openNativeBrowser: native.open, createNativePage: native.create, closeNativeBrowser: native.close,
  nativeOpener: async () => null,
}))
vi.mock('../src/main/native-layout.js', () => ({ nativePagesVisible: () => false }))
vi.mock('../src/main/available-memory.js', () => ({ availableMemory: () => 8e9 }))
vi.mock('../src/main/memory-plan.js', () => ({ reserveRoom: () => () => {} }))
vi.mock('../src/main/stalled-scripts.js', () => ({ watchStalledScripts: () => {} }))
vi.mock('../src/main/page-downloads.js', () => ({ watchDownloads: () => () => {}, takeDownloads: () => [] }))
import { addAgentPage, agentBrowserRunning, closeAgentBrowser, ensureAgentPage, laneOf } from '../src/main/agent-browser.js'

const page = () => Object.assign(new EventEmitter(), { isClosed: () => false, url: () => 'about:blank' }) as unknown as Page
afterEach(async () => { await closeAgentBrowser({ force: true }); vi.useRealTimers(); vi.clearAllMocks() })

it('opens another conversation while one allocation hangs and never opens an expired queued tab', async () => {
  vi.useFakeTimers()
  const context = Object.assign(new EventEmitter(), { pages: () => [] })
  native.open.mockResolvedValue(context)
  let finish!: (page: Page) => void
  const first = page(), second = page()
  native.create.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockImplementationOnce(async () => { context.emit('page', second); return second })
  const blocked = ensureAgentPage('blocked')
  await vi.advanceTimersByTimeAsync(0)
  const other = ensureAgentPage('other')
  await vi.advanceTimersByTimeAsync(0)
  expect(await other).toBe(second)
  expect(laneOf(second)).toBe('other')
  const queued = addAgentPage('blocked')
  const rejected = expect(queued).rejects.toThrow('within 30 seconds')
  await vi.advanceTimersByTimeAsync(30_001)
  await rejected
  context.emit('page', first)
  finish(first)
  expect(await blocked).toBe(first)
  await vi.advanceTimersByTimeAsync(0)
  expect(laneOf(first)).toBe('blocked')
  expect(laneOf(second)).toBe('other')
  expect(native.create).toHaveBeenCalledTimes(2)
})

it('joins a pending browser shutdown instead of repeatedly completing new quit requests', async () => {
  const context = Object.assign(new EventEmitter(), { pages: () => [page()] })
  native.open.mockResolvedValue(context)
  await ensureAgentPage('closing')
  let finish!: () => void
  native.close.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
  const first = closeAgentBrowser({ force: true })
  let ended = false
  const second = closeAgentBrowser({ force: true }).then(() => { ended = true })
  await new Promise(resolve => setTimeout(resolve, 0))
  try {
    expect(ended).toBe(false)
    expect(native.close).toHaveBeenCalledOnce()
    expect(agentBrowserRunning()).toBe(true)
  } finally { finish(); await Promise.all([first, second]) }
  expect(agentBrowserRunning()).toBe(false)
})
