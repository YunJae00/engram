import { expect, it, vi } from 'vitest'
import { quitGuard } from '../src/main/quit-guard.js'

it('retries once at 25 seconds and exits at 35 without extending repeated quit requests', async () => {
  vi.useFakeTimers()
  try {
    const exit = vi.fn(), retry = vi.fn(() => guard())
    const guard = quitGuard(retry, exit)
    guard()
    await vi.advanceTimersByTimeAsync(20_000)
    guard()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(retry).toHaveBeenCalledOnce()
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(exit).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(retry).toHaveBeenCalledOnce()
    expect(exit).toHaveBeenCalledOnce()
  } finally { vi.useRealTimers() }
})
