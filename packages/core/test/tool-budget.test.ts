import { describe, expect, it, vi } from 'vitest'
import { toolBudgetMs, withinBudget } from '../src/tool-budget.js'

describe('a budget for each tool call', () => {
  it('stops a call that runs past its budget and tells the call through its signal', async () => {
    vi.useFakeTimers()
    let seen: AbortSignal | undefined
    const pending = withinBudget('outlook_mail', new AbortController().signal, (signal) => { seen = signal; return new Promise<string>(() => undefined) })
    const outcome = pending.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(toolBudgetMs('outlook_mail')! + 1)
    expect(await outcome).toMatch(/outlook_mail took longer than 45s and was stopped/)
    expect(seen?.aborted).toBe(true)
    vi.useRealTimers()
  })

  it('passes a quick answer through and leaves calls that wait on the person unbounded', async () => {
    expect(await withinBudget('read_note', new AbortController().signal, async () => 'note')).toBe('note')
    expect(toolBudgetMs('press')).toBeNull()
    expect(toolBudgetMs('app_press')).toBeNull()
    expect(toolBudgetMs('app_text')).toBeGreaterThan(180_000)
    const parent = new AbortController()
    let seen: AbortSignal | undefined
    const pending = withinBudget('search_web', parent.signal, (signal) => { seen = signal; return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))) })
    parent.abort()
    await expect(pending).rejects.toThrow('stopped')
    expect(seen?.aborted).toBe(true)
  })
})
