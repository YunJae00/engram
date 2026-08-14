import { beforeEach, describe, expect, it } from 'vitest'
import { EngineBackoff } from '../src/engine/backoff.js'
import { parseRetryAfterMs } from '../src/engine/claude.js'
import type { Engine, EngineEvent } from '../src/engine/types.js'
import { JobRunner, type JobSpec } from '../src/jobs/runner.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const T = 1_753_900_000_000

let paths: VaultPaths
beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('backoff'), { git: false })
})

const job = (inputKey: string): JobSpec => ({
  kind: 'J2',
  inputKey,
  instruction: 'x',
  prompt: `JOB: default\n${inputKey}`,
  apply: async () => ['ok'],
})

function quotaEngine(message: string): Engine & { calls: number } {
  const engine = {
    id: 'mock' as const,
    calls: 0,
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run(): AsyncIterable<EngineEvent> {
      engine.calls += 1
      yield { type: 'error', message, kind: 'quota', retryAfterMs: parseRetryAfterMs(message, T) }
    },
  }
  return engine
}

describe('the shared quota gate', () => {
  it('a quota halt carries the CLI retry-after out on the report', async () => {
    // The gate itself lives in the DESKTOP (a core-level gate blocked the
    // substitute engine and leaked across runs). Core's contract is the
    // evidence: halt + the parsed retry-after riding the report.
    const engine = quotaEngine('429 rate limit — retry after 600 seconds')
    const runner = new JobRunner(paths, [engine], { retryDelayMs: 0 })
    const report = await runner.runAll([job('a'), job('b'), job('c')])
    expect(engine.calls).toBe(1) // halt defers the rest without spawning
    expect(report.haltReason).toBe('quota')
    expect(report.quotaRetryAfterMs).toBe(600_000)
  })

  it('the gate opens by clock and closes only on success', () => {
    const backoff = new EngineBackoff(() => 0)
    backoff.noteQuota(undefined, T)
    const first = backoff.blockedMs(T)
    // rng()=0 → half of base*2^1 = 5min: the jitter floor.
    expect(first).toBe(5 * 60_000)
    expect(backoff.blockedMs(T + first + 1)).toBe(0)
    backoff.noteQuota(undefined, T)
    backoff.noteOk()
    expect(backoff.blockedMs(T)).toBe(0)
  })

  it('repeat quotas back off exponentially, capped, and extension never shortens', () => {
    const backoff = new EngineBackoff(() => 1)
    backoff.noteQuota(undefined, T) // 2^1 → 10min
    const one = backoff.blockedMs(T)
    backoff.noteQuota(undefined, T) // 2^2 → 20min
    const two = backoff.blockedMs(T)
    expect(two).toBeGreaterThan(one)
    for (let i = 0; i < 10; i++) backoff.noteQuota(undefined, T)
    expect(backoff.blockedMs(T)).toBeLessThanOrEqual(60 * 60_000)
    // A concurrent worker reporting a SHORTER retry-after must not shorten.
    const armed = backoff.blockedMs(T)
    backoff.noteQuota(1_000, T)
    expect(backoff.blockedMs(T)).toBe(armed)
  })
})

describe('parseRetryAfterMs', () => {
  it('reads seconds, epochs, and garbage honestly', () => {
    expect(parseRetryAfterMs('retry after 3600 seconds')).toBe(3_600_000)
    expect(parseRetryAfterMs('Retry-After: 120')).toBe(120_000)
    expect(parseRetryAfterMs(`usage limit — resets at ${Math.floor(T / 1000) + 600}`, T)).toBe(600_000)
    expect(parseRetryAfterMs('quota exhausted, come back later')).toBeUndefined()
    // A reset time in the past is not a wait.
    expect(parseRetryAfterMs(`resets at ${Math.floor(T / 1000) - 600}`, T)).toBeUndefined()
  })
})
