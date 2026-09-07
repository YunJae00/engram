import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const deps = vi.hoisted(() => ({ prepare: vi.fn(), cancel: vi.fn(), capture: vi.fn() }))
vi.mock('../src/renderer/src/api.js', () => ({ api: { desktopPrepareCapture: deps.prepare, desktopCancelCapture: deps.cancel } }))
let openDesktopStream: typeof import('../src/renderer/src/lib/desktopStream.js').openDesktopStream

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fakeStream() {
  const track = { stop: vi.fn() }
  return { stream: { getTracks: () => [track] } as unknown as MediaStream, track }
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  deps.prepare.mockReset().mockImplementation(async (lane: string) => `grant-${lane}`)
  deps.cancel.mockReset().mockResolvedValue(undefined)
  deps.capture.mockReset()
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: deps.capture } })
  ;({ openDesktopStream } = await import('../src/renderer/src/lib/desktopStream.js'))
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('live window stream startup', () => {
  it('serializes grants and requests video without any audio', async () => {
    const gate = deferred<MediaStream>()
    const first = fakeStream(); const second = fakeStream()
    deps.capture.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(second.stream)
    const one = openDesktopStream('bot-a')
    const two = openDesktopStream('bot-b')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith('bot-a')
    gate.resolve(first.stream)
    expect(await one).toBe(first.stream)
    expect(await two).toBe(second.stream)
    expect(deps.capture).toHaveBeenCalledWith({ audio: false, video: { width: { ideal: 2560 }, height: { ideal: 1600 }, frameRate: { ideal: 30, max: 30 } } })
    expect(deps.cancel.mock.calls).toEqual([['grant-bot-a'], ['grant-bot-b']])
  })

  it('does not prepare a queued tile that was cancelled before it started', async () => {
    const gate = deferred<MediaStream>()
    deps.capture.mockReturnValue(gate.promise)
    const one = openDesktopStream('bot-a')
    const controller = new AbortController()
    const two = openDesktopStream('bot-b', controller.signal).catch((cause: unknown) => cause)
    controller.abort(new Error('Tile removed'))
    gate.resolve(fakeStream().stream)
    await one
    expect(await two).toEqual(new Error('Tile removed'))
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith('bot-a')
  })

  it('cancels an in-flight capture, starts the next tile and stops any late stream', async () => {
    const gate = deferred<MediaStream>()
    const late = fakeStream(); const current = fakeStream()
    deps.capture.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(current.stream)
    const controller = new AbortController()
    const one = openDesktopStream('bot-a', controller.signal).catch((cause: unknown) => cause)
    const two = openDesktopStream('bot-b')
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('Hidden'))
    expect(await one).toEqual(new Error('Hidden'))
    expect(await two).toBe(current.stream)
    gate.resolve(late.stream)
    await vi.advanceTimersByTimeAsync(0)
    expect(late.track.stop).toHaveBeenCalledOnce()
    expect(current.track.stop).not.toHaveBeenCalled()
    expect(deps.cancel).toHaveBeenCalledWith('grant-bot-a')
  })

  it('cancels a late prepare grant without asking the browser for a stale stream', async () => {
    const gate = deferred<string>()
    deps.prepare.mockReturnValueOnce(gate.promise)
    const controller = new AbortController()
    const result = openDesktopStream('bot-a', controller.signal).catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(0)
    controller.abort(new Error('Disconnected'))
    expect(await result).toEqual(new Error('Disconnected'))
    gate.resolve('late-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.capture).not.toHaveBeenCalled()
    expect(deps.cancel).toHaveBeenCalledExactlyOnceWith('late-token')
  })

  it('bounds a hung startup and lets a later tile recover without leaking late frames', async () => {
    const gate = deferred<MediaStream>()
    const late = fakeStream(); const current = fakeStream()
    deps.capture.mockReturnValueOnce(gate.promise).mockResolvedValueOnce(current.stream)
    const one = openDesktopStream('bot-a').catch((cause: unknown) => cause)
    const two = openDesktopStream('bot-b')
    await vi.advanceTimersByTimeAsync(12000)
    expect(String(await one)).toContain('too long')
    expect(await two).toBe(current.stream)
    gate.resolve(late.stream)
    await vi.advanceTimersByTimeAsync(0)
    expect(late.track.stop).toHaveBeenCalledOnce()
  })

  it('bounds a hung prepare and cleans its eventual grant', async () => {
    const gate = deferred<string>()
    deps.prepare.mockReturnValueOnce(gate.promise)
    const result = openDesktopStream('bot-a').catch((cause: unknown) => cause)
    await vi.advanceTimersByTimeAsync(12000)
    expect(String(await result)).toContain('too long')
    gate.resolve('late-token')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.cancel).toHaveBeenCalledExactlyOnceWith('late-token')
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it('does not stall the queue if cancellation IPC itself never responds', async () => {
    deps.cancel.mockReturnValue(new Promise(() => undefined))
    deps.capture.mockImplementation(async () => fakeStream().stream)
    await openDesktopStream('bot-a')
    await openDesktopStream('bot-b')
    expect(deps.prepare).toHaveBeenCalledTimes(2)
  })

  it('cleans a rejected browser grant and permits a new attempt', async () => {
    deps.capture.mockRejectedValueOnce(new Error('Denied')).mockResolvedValueOnce(fakeStream().stream)
    await expect(openDesktopStream('bot-a')).rejects.toThrow('Denied')
    await openDesktopStream('bot-b')
    expect(deps.cancel).toHaveBeenCalledTimes(2)
  })
})
