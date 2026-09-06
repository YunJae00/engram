import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPreviewPool } from '../src/main/preview-pool.js'

afterEach(() => vi.useRealTimers())

describe('page preview ownership', () => {
  it('shares startup and keeps the stream across a view handoff', async () => {
    vi.useFakeTimers()
    let publish!: (frame: string) => void
    const stop = vi.fn(async () => undefined)
    const open = vi.fn(async (_page: object, receive: (frame: string) => void) => { publish = receive; return stop })
    const acquire = createPreviewPool(open)
    const page = {}
    const first = vi.fn(), second = vi.fn()
    const [leaveFirst, leaveSecond] = await Promise.all([acquire(page, first), acquire(page, second)])
    expect(open).toHaveBeenCalledOnce()
    publish('one')
    expect(first).toHaveBeenCalledWith('one')
    expect(second).toHaveBeenCalledWith('one')
    leaveFirst()
    publish('two')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    leaveSecond()
    await vi.advanceTimersByTimeAsync(100)
    const third = vi.fn()
    const leaveThird = await acquire(page, third)
    expect(third).toHaveBeenCalledWith('two')
    await vi.advanceTimersByTimeAsync(200)
    expect(stop).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledOnce()
    leaveThird()
    leaveThird()
    await vi.advanceTimersByTimeAsync(200)
    expect(stop).toHaveBeenCalledOnce()
  })

  it('waits for the previous encoder to detach before opening its replacement', async () => {
    vi.useFakeTimers()
    let detach!: () => void
    const stop = vi.fn(() => new Promise<void>((resolve) => { detach = resolve }))
    const open = vi.fn(async () => stop)
    const acquire = createPreviewPool<object, string>(open)
    const page = {}, receive = vi.fn()
    const leave = await acquire(page, receive)
    leave()
    await vi.advanceTimersByTimeAsync(200)
    const replacement = acquire(page, receive)
    expect(open).toHaveBeenCalledOnce()
    detach()
    const leaveNext = await replacement
    expect(open).toHaveBeenCalledTimes(2)
    leaveNext()
    await vi.advanceTimersByTimeAsync(200)
    detach()
  })

  it('allows retry after startup fails and separates different pages', async () => {
    vi.useFakeTimers()
    const stop = vi.fn(async () => undefined)
    const open = vi.fn(async () => stop).mockRejectedValueOnce(new Error('closed session'))
    const acquire = createPreviewPool<object, string>(open)
    const page = {}, receive = vi.fn()
    await expect(acquire(page, receive)).rejects.toThrow('closed session')
    const [one, two] = await Promise.all([acquire(page, receive), acquire({}, receive)])
    expect(open).toHaveBeenCalledTimes(3)
    one(); two()
    await vi.advanceTimersByTimeAsync(200)
    expect(stop).toHaveBeenCalledTimes(2)
  })
})
