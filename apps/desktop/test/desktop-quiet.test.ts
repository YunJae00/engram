import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopMethod } from '../src/main/desktop-host.js'

const deps = vi.hoisted(() => ({ bind: vi.fn(), current: vi.fn(), stopped: vi.fn(), flog: vi.fn() }))
vi.mock('../src/main/desktop-access.js', () => ({ bindDesktopForLane: deps.bind, desktopBinding: deps.current }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: deps.stopped }))
vi.mock('../src/main/flog.js', () => ({ flog: deps.flog }))
import { awaitPersonAway, forgetQuietCoverage, quietScan, quietSet, quietText, quietVerdict } from '../src/main/desktop-quiet.js'

function binding(state: { foreground: boolean; idleMs: number }, texts: string[] = ['answer']) {
  let reads = 0
  const request = vi.fn<(method: DesktopMethod, args: Record<string, unknown>) => Promise<unknown>>(async (method) => {
    if (method === 'quietState') return { ...state, minimized: false }
    if (method === 'quietScan') return { snapshot: 'f'.repeat(32), controls: [], texts: [] }
    if (method === 'quietSet') return { landed: true, value: 'hello', ms: 120, control: 'c1' }
    if (method === 'quietRead') { const text = texts[Math.min(reads, texts.length - 1)]!; reads++; return { text, chars: text.length, headClipped: false } }
    return {}
  })
  const held = { lane: 'bot-one', source: 'window:7:0', name: 'Claude', readable: true, window: '7', pid: 70, stopped: false, revision: 0, host: { request, closed: false, close: vi.fn() } }
  deps.bind.mockResolvedValue(held)
  deps.current.mockReturnValue(held)
  return { held, request, state }
}

beforeEach(() => { vi.useFakeTimers(); vi.resetAllMocks(); forgetQuietCoverage() })
afterEach(() => { vi.useRealTimers() })

describe('quiet app access', () => {
  it('only allows foreground fallback after a read or an unsupported provider action', async () => {
    const { request } = binding({ foreground: false, idleMs: 9000 })
    expect(quietVerdict('bot-one', 'Claude').verdict).toBe('unknown')
    await quietScan('bot-one', 'Claude', undefined)
    expect(quietVerdict('bot-one', 'Claude').verdict).toBe('bare')
    request.mockResolvedValueOnce({ controls: [{ id: 'c1' }], texts: [] })
    await quietScan('bot-one', 'Claude', undefined)
    expect(quietVerdict('bot-one', 'Claude').verdict).toBe('covered')
    request.mockImplementation(async method => {
      if (method === 'quietState') return { foreground: false, idleMs: 9000 }
      if (method === 'quietSet') throw new Error('This control does not take text')
      return {}
    })
    await expect(quietSet('bot-one', 'Claude', 'snapshot', 'c1', 'draft', undefined)).rejects.toThrow('does not take text')
    expect(quietVerdict('bot-one', 'Claude').verdict).toBe('bare')
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1)
    expect(quietVerdict('bot-one', 'Claude').verdict).toBe('unknown')
  })

  it('cannot bypass a stopped desktop turn', async () => {
    const { request } = binding({ foreground: false, idleMs: 9000 })
    deps.stopped.mockImplementation(() => { throw new Error('Stopped by the user') })
    await expect(quietScan('bot-one', 'Claude', undefined)).rejects.toThrow('Stopped by the user')
    expect(request).not.toHaveBeenCalled()
  })

  it('does not mutate after cancellation or changing the selected window while waiting', async () => {
    const busy = binding({ foreground: true, idleMs: 100 })
    const controller = new AbortController()
    const pending = quietSet('bot-one', 'Claude', 'f'.repeat(32), 'c1', 'hello', undefined, controller.signal)
    const outcome = pending.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(100)
    controller.abort(new Error('cancelled'))
    expect(await outcome).toBe('cancelled')
    expect(busy.request.mock.calls.some(([method]) => method === 'quietSet')).toBe(false)

    const changed = binding({ foreground: true, idleMs: 100 })
    const second = quietSet('bot-one', 'Claude', 'f'.repeat(32), 'c1', 'hello', undefined).catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(100)
    deps.current.mockReturnValue(undefined)
    await vi.advanceTimersByTimeAsync(500)
    expect(await second).toContain('connection changed')
    expect(changed.request.mock.calls.some(([method]) => method === 'quietSet')).toBe(false)
  })

  it('closes only its helper when cancelled during a native operation', async () => {
    const { held, request } = binding({ foreground: false, idleMs: 9000 })
    let finish!: (value: unknown) => void
    request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = quietScan('bot-one', 'Claude', undefined, controller.signal).catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error('cancelled'))
    expect(held.host.close).toHaveBeenCalledOnce()
    finish({ snapshot: 'stale' })
    expect(await pending).toBe('cancelled')
  })
  it('reads an app without taking control of the computer', async () => {
    const { request } = binding({ foreground: true, idleMs: 100 })
    const result = await quietScan('bot-one', 'Claude', 'Send')
    expect(result.snapshot).toBe('f'.repeat(32))
    // The window already bound for this chat is reused; another title binds anew.
    expect(deps.bind).not.toHaveBeenCalled()
    await quietScan('bot-one', 'Notes', undefined)
    expect(deps.bind).toHaveBeenCalledWith('bot-one', { app: 'Notes' })
    expect(request).toHaveBeenCalledWith('quietScan', { window: '7', pid: 70, find: 'Send' })
    expect(request.mock.calls.map(([method]) => method)).not.toContain('bind')
  })

  it('sets a field at once when the person is elsewhere, and waits while they type in that app', async () => {
    const away = binding({ foreground: false, idleMs: 50 })
    await quietSet('bot-one', 'Claude', 'f'.repeat(32), 'c1', 'hello', undefined)
    expect(away.request.mock.calls.map(([method]) => method)).toEqual(['quietState', 'applicationFrame', 'quietSet'])
    await vi.advanceTimersByTimeAsync(2_600)
    expect(away.request.mock.calls.map(([method]) => method).at(-1)).toBe('applicationFrameHide')

    const busy = binding({ foreground: true, idleMs: 200 })
    const pending = quietSet('bot-one', 'Claude', 'f'.repeat(32), 'c1', 'hello', 'old')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(busy.request.mock.calls.map(([method]) => method)).not.toContain('quietSet')
    busy.state.idleMs = 9_000
    await vi.advanceTimersByTimeAsync(600)
    await expect(pending).resolves.toMatchObject({ landed: true })
    expect(busy.request).toHaveBeenLastCalledWith('quietSet', { window: '7', pid: 70, snapshot: 'f'.repeat(32), control: 'c1', text: 'hello', expected: 'old' })
    expect(deps.flog).toHaveBeenCalledWith('desktop-quiet', expect.stringContaining('waited'))
  })

  it('gives up after a minute rather than typing under the person\'s hands', async () => {
    const { held } = binding({ foreground: true, idleMs: 10 })
    const pending = awaitPersonAway(held as never)
    const outcome = pending.then(() => 'done', (error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(await outcome).toContain('using "Claude" right now')
  })

  it('returns text at once without a settle, and waits for streaming text to stop changing with one', async () => {
    binding({ foreground: false, idleMs: 0 }, ['first', 'first more', 'first more done', 'first more done'])
    expect(await quietText('bot-one', 'Claude', undefined, undefined, 0)).toMatchObject({ text: 'first', settled: true, waitedMs: 0 })

    binding({ foreground: false, idleMs: 0 }, ['first', 'first more', 'first more done'])
    const pending = quietText('bot-one', 'Claude', 'f'.repeat(32), 't3', 3_000)
    await vi.advanceTimersByTimeAsync(6_500)
    const result = await pending
    expect(result.text).toBe('first more done')
    expect(result.settled).toBe(true)
    expect(result.waitedMs).toBeGreaterThanOrEqual(5_000)
  })

  it('does not take a status line that holds still for an answer while the app offers to stop it', async () => {
    const { request } = binding({ foreground: false, idleMs: 0 }, [...Array<string>(5).fill('Starting work'), '2'])
    const stop = { id: 'c4', type: 'Button', name: '중지', can: { set: false, press: true, text: false }, enabled: true, offscreen: false }
    let scans = 0
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method, args) => method === 'quietScan' ? { snapshot: 'f'.repeat(32), controls: ++scans < 3 ? [stop] : [], texts: [] } : original(method, args))
    const pending = quietText('bot-one', 'Claude', undefined, undefined, 2_000)
    await vi.advanceTimersByTimeAsync(20_000)
    const result = await pending
    expect(result).toMatchObject({ text: '2', settled: true })
    expect(scans).toBeGreaterThanOrEqual(3)
  })
})
