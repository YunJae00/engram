import { rename } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renameWithRetry } from '../src/rename-with-retry.js'

vi.mock('node:fs/promises', () => ({ rename: vi.fn() }))

const move = vi.mocked(rename)
const failure = (code: string) => Object.assign(new Error(code), { code })

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  move.mockReset().mockResolvedValue(undefined)
})

afterEach(() => vi.useRealTimers())

describe('atomic rename retries', () => {
  it('returns immediately when the first rename succeeds', async () => {
    await renameWithRetry('scratch', 'target', 'win32')
    expect(move).toHaveBeenCalledExactlyOnceWith('scratch', 'target')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient Windows %s without changing paths', async (code) => {
    move.mockRejectedValueOnce(failure(code)).mockRejectedValueOnce(failure(code))
    const result = renameWithRetry('scratch', 'target', 'win32')
    await vi.advanceTimersByTimeAsync(19)
    expect(move).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(move).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(40)
    await result
    expect(move.mock.calls).toEqual(Array.from({ length: 3 }, () => ['scratch', 'target']))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops after six attempts and propagates the final permission error', async () => {
    const error = failure('EPERM')
    move.mockRejectedValue(error)
    const result = expect(renameWithRetry('scratch', 'target', 'win32')).rejects.toBe(error)
    await vi.runAllTimersAsync()
    await result
    expect(move).toHaveBeenCalledTimes(6)
    expect(Date.now()).toBe(620)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['ENOENT', 'EXDEV', 'ENOSPC'])('does not retry %s', async (code) => {
    const error = failure(code)
    move.mockRejectedValue(error)
    await expect(renameWithRetry('scratch', 'target', 'win32')).rejects.toBe(error)
    expect(move).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['linux', 'darwin'] as const)('does not retry permission errors on %s', async (platform) => {
    const error = failure('EPERM')
    move.mockRejectedValue(error)
    await expect(renameWithRetry('scratch', 'target', platform)).rejects.toBe(error)
    expect(move).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([null, 'EPERM', new Error('unknown')])('preserves an error without a retryable code: %s', async (error) => {
    move.mockRejectedValue(error)
    await expect(renameWithRetry('scratch', 'target', 'win32')).rejects.toBe(error)
    expect(move).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops when a transient error becomes permanent', async () => {
    const error = failure('ENOENT')
    move.mockRejectedValueOnce(failure('EBUSY')).mockRejectedValue(error)
    const result = expect(renameWithRetry('scratch', 'target', 'win32')).rejects.toBe(error)
    await vi.runAllTimersAsync()
    await result
    expect(move).toHaveBeenCalledTimes(2)
    expect(Date.now()).toBe(20)
    expect(vi.getTimerCount()).toBe(0)
  })
})
