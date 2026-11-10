import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { capInstructions, instructionsSaver } from '../src/renderer/src/lib/botInfo.js'

describe('instructions save debounced, cap 2000', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  const setup = (save = vi.fn<(id: string, purpose: string) => Promise<unknown>>(() => Promise.resolve())) => {
    const onError = vi.fn()
    return { save, onError, saver: instructionsSaver(save, onError) }
  }

  it('saves once, 500 ms after the last of ten edits', () => {
    const { save, saver } = setup()
    for (let i = 0; i < 10; i++) {
      saver.edit('a', `text ${i}`)
      vi.advanceTimersByTime(50)
    }
    vi.advanceTimersByTime(449)
    expect(save).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledWith('a', 'text 9')
  })

  it('caps at 2000 UTF-16 units without splitting a surrogate pair', () => {
    expect(capInstructions('x'.repeat(2500))).toBe('x'.repeat(2000))
    const { save, saver } = setup()
    saver.edit('a', 'a'.repeat(1999) + '😀')
    vi.advanceTimersByTime(500)
    expect(save).toHaveBeenCalledWith('a', 'a'.repeat(1999))
  })

  it('flushes a pending edit to the old bot on switch', () => {
    const { save, saver } = setup()
    saver.edit('A', 'x')
    saver.edit('B', 'y')
    expect(save.mock.calls).toEqual([['A', 'x']])
    vi.advanceTimersByTime(500)
    expect(save.mock.calls).toEqual([['A', 'x'], ['B', 'y']])
  })

  it('flush saves only a pending edit, once', () => {
    const { save, saver } = setup()
    saver.flush()
    expect(save).not.toHaveBeenCalled()
    saver.edit('a', 'z')
    saver.flush()
    expect(save).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    saver.flush()
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('reports a rejected save once without throwing', async () => {
    const failure = new Error('nope')
    const { onError, saver } = setup(vi.fn(() => Promise.reject(failure)))
    saver.edit('a', 'q')
    expect(() => vi.advanceTimersByTime(500)).not.toThrow()
    await vi.runAllTimersAsync()
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith(failure)
  })
})
