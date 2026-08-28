import { describe, expect, it } from 'vitest'
import { fetchIfMissing, RETRY_AFTER_MS, retryDue, type FetchDeps } from '../src/main/local-model-fetch.js'

// The brain arrives by itself; what the tests pin down is when it does NOT
// try: with the file already there, and within a day of a failed attempt.
function deps(over: Partial<FetchDeps> & { failedAt?: number | null; present?: boolean }): FetchDeps & { calls: string[]; failures: string[] } {
  const calls: string[] = []
  const failures: string[] = []
  return {
    calls,
    failures,
    missing: async () => (over.present ? null : 'brain'),
    download: async (id) => {
      calls.push(id)
      return { ok: true }
    },
    lastFailedAt: async () => over.failedAt ?? null,
    noteFailure: async (_at, log) => {
      failures.push(log)
    },
    now: () => 1_000_000_000_000,
    ...over,
  }
}

describe('retryDue', () => {
  it('is due with no failure on record, and a day after one', () => {
    expect(retryDue(null, 10)).toBe(true)
    expect(retryDue(100, 100 + RETRY_AFTER_MS)).toBe(true)
    expect(retryDue(100, 100 + RETRY_AFTER_MS - 1)).toBe(false)
  })
})

describe('fetchIfMissing', () => {
  it('leaves a present model alone', async () => {
    const d = deps({ present: true })
    expect(await fetchIfMissing(d)).toBe('present')
    expect(d.calls).toEqual([])
  })

  it('downloads a missing one', async () => {
    const d = deps({})
    expect(await fetchIfMissing(d)).toBe('downloaded')
    expect(d.calls).toEqual(['brain'])
  })

  it('waits a day after a failure, then tries again', async () => {
    const recent = deps({ failedAt: 1_000_000_000_000 - 3_600_000 })
    expect(await fetchIfMissing(recent)).toBe('waiting')
    expect(recent.calls).toEqual([])
    const stale = deps({ failedAt: 1_000_000_000_000 - RETRY_AFTER_MS })
    expect(await fetchIfMissing(stale)).toBe('downloaded')
  })

  it('records a failure, but not a cancel', async () => {
    const failing = deps({ download: async () => ({ ok: false, log: 'proxy refused' }) })
    expect(await fetchIfMissing(failing)).toBe('failed')
    expect(failing.failures).toEqual(['proxy refused'])
    const canceled = deps({ download: async () => ({ ok: false, log: 'canceled' }) })
    expect(await fetchIfMissing(canceled)).toBe('failed')
    expect(canceled.failures).toEqual([])
  })
})
