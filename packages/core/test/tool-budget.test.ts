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
    expect(toolBudgetMs('press')).toBe(420_000)
    expect(toolBudgetMs('app_press')).toBe(420_000)
    expect(toolBudgetMs('ask_person')).toBeNull()
    expect(toolBudgetMs('app_text')).toBeGreaterThan(180_000)
    const parent = new AbortController()
    let seen: AbortSignal | undefined
    const pending = withinBudget('search_web', parent.signal, (signal) => { seen = signal; return new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')))) })
    parent.abort()
    await expect(pending).rejects.toThrow('stopped')
    expect(seen?.aborted).toBe(true)
  })
})

it('bounds every configured tool except ask_person, including unknown native tools', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../src/tool-budget.ts', import.meta.url), 'utf8')
  expect([...source.matchAll(/(\w+): null/g)].map(match => match[1])).toEqual(['ask_person'])
  for (const name of ['press', 'press_point', 'app_press', 'page_steps', 'desktop_action', 'desktop_sequence', 'upload_file', 'run_procedure']) {
    expect(toolBudgetMs(name)).toBeGreaterThan(300_000)
    expect(Number.isFinite(toolBudgetMs(name))).toBe(true)
  }
  expect(toolBudgetMs('unknown_native_tool')).toBe(45_000)
})

it('cancels even an unlimited tool that ignores its abort signal', async () => {
  const parent = new AbortController()
  const pending = withinBudget('ask_person', parent.signal, () => new Promise(() => {}))
  parent.abort(new Error('Stopped by person'))
  await expect(pending).rejects.toThrow('Stopped by person')
})

it('excludes approval waiting time but still enforces the remaining execution budget', async () => {
  vi.useFakeTimers()
  try {
    let waiting = false
    const pending = withinBudget('press', new AbortController().signal, () => new Promise(() => {}), () => waiting)
    const rejected = expect(pending).rejects.toThrow('press took longer than 420s')
    await vi.advanceTimersByTimeAsync(300_000)
    waiting = true
    await vi.advanceTimersByTimeAsync(3_600_000)
    waiting = false
    await vi.advanceTimersByTimeAsync(120_000)
    await rejected
    expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
