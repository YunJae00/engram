import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { foreignHost, stalledAfter, watchStalledScripts } from '../src/main/stalled-scripts.js'

const request = (url: string, page: string, firstByte = -1) => ({ resourceType: () => 'script', url: () => url, frame: () => ({ url: () => page }), timing: () => ({ responseStart: firstByte }) }) as never

describe('scripts from another site that do not answer', () => {
  it('tells another site from the page own hosts', () => {
    expect(foreignHost('https://wcs.example.net/log.js', 'https://www.jobs.example.org/list')).toBe('wcs.example.net')
    expect(foreignHost('https://static.jobs.example.org/app.js', 'https://www.jobs.example.org/list')).toBeNull()
  })

  it('counts a stall by the first byte, or by the wait when none came', () => {
    expect(stalledAfter(12_000, 200)).toBe(false)
    expect(stalledAfter(12_000, 9_000)).toBe(true)
    expect(stalledAfter(10_500, -1)).toBe(true)
    expect(stalledAfter(800, -1)).toBe(false)
  })

  it('blocks a stalled host in every open and later page, and never the page own scripts', async () => {
    vi.useFakeTimers()
    const handlers: Record<string, (value: never) => void> = {}
    const send = vi.fn(async () => ({}))
    const page = { isClosed: () => false, url: () => 'https://jobs.site.test/a', on: vi.fn() }
    const context = { on: (event: string, handler: (value: never) => void) => { handlers[event] = handler }, pages: () => [page], newCDPSession: vi.fn(async () => ({ send })) }
    watchStalledScripts(context as never)
    const slow = request('https://wcs.stall.test/log.js', 'https://jobs.site.test/a')
    const own = request('https://cdn.site.test/app.js', 'https://jobs.site.test/a')
    handlers['request']!(slow)
    handlers['request']!(own)
    vi.advanceTimersByTime(10_000)
    handlers['requestfinished']!(own)
    await vi.runAllTimersAsync()
    expect(send).not.toHaveBeenCalled()
    handlers['requestfailed']!(slow)
    await vi.runAllTimersAsync()
    expect(send).toHaveBeenCalledWith('Network.setBlockedURLs', { urls: ['https://wcs.stall.test/log.js'] })
    handlers['page']!({ isClosed: () => false, url: () => 'https://wcs.stall.test/a', on: vi.fn() } as never)
    await vi.runAllTimersAsync()
    expect(context.newCDPSession).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith('Network.setBlockedURLs', { urls: [] })
    const unrelated = { ...context, on: vi.fn(), newCDPSession: vi.fn() }
    watchStalledScripts(unrelated as never)
    expect(unrelated.newCDPSession).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})
