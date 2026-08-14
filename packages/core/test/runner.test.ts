import { beforeEach, describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import type { Engine, EngineEvent } from '../src/engine/types.js'
import { JobRunner, type JobSpec } from '../src/jobs/runner.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

function engineOf(id: string, handler: (prompt: string) => EngineEvent[]): Engine {
  return {
    id: id as Engine['id'],
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run(job) {
      yield* handler(job.prompt)
    },
  }
}

const ok = (text: string) => [{ type: 'result', text } as EngineEvent]
const quota = () => [{ type: 'error', message: '429 rate limit' } as EngineEvent]
const boom = () => [{ type: 'error', message: 'engine crashed' } as EngineEvent]
const deadLogin = () => [{ type: 'error', message: 'Invalid API key · Please run /login' } as EngineEvent]

function job(kind: 'J1' | 'J5', key: string, applied: string[]): JobSpec {
  return {
    kind,
    inputKey: key,
    instruction: `INSTRUCTION: ${kind}`,
    prompt: `JOB: ${kind}\n${key}`,
    apply: async (result) => {
      applied.push(`${key}:${result}`)
      return [`applied ${key}`]
    },
  }
}

let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('runner'), { git: false })
})

describe('job runner', () => {
  it('runs serially and the journal makes reruns no-ops (硫깅벑)', async () => {
    const applied: string[] = []
    const runner = new JobRunner(paths, [engineOf('mock', () => ok('r'))])
    const jobs = [job('J1', 'a', applied), job('J5', 'b', applied)]
    const first = await runner.runAll(jobs)
    expect(first.executed).toBe(2)
    const second = await runner.runAll(jobs)
    expect(second.executed).toBe(0)
    expect(second.skipped).toBe(2)
    expect(applied).toHaveLength(2)
  })

  it('retries once, then records the failure and moves on', async () => {
    let calls = 0
    const flaky = engineOf('mock', () => {
      calls++
      return boom()
    })
    const applied: string[] = []
    const runner = new JobRunner(paths, [flaky])
    const report = await runner.runAll([job('J1', 'x', applied), job('J5', 'y', applied)])
    expect(calls).toBe(4) // 2 attempts 횞 2 jobs
    expect(report.failed.map((f) => f.inputKey)).toEqual(['x', 'y'])
    expect(applied).toEqual([])
  })

  it('kills a job on timeout', async () => {
    const stuck = new MockEngine({}, { hangTimes: 99 })
    const runner = new JobRunner(paths, [stuck], { timeoutMs: 50, retryDelayMs: 0 })
    const report = await runner.runAll([job('J1', 'slow', [])])
    expect(report.failed[0]?.error).toContain('timed out')
  })

  it('429 ??substitutes the next engine for the rest of the run', async () => {
    const applied: string[] = []
    let aCalls = 0
    const engineA = engineOf('claude', () => {
      aCalls++
      return aCalls === 1 ? ok('from-a') : quota()
    })
    const engineB = engineOf('mock', () => ok('from-b'))
    const runner = new JobRunner(paths, [engineA, engineB])
    const report = await runner.runAll([job('J1', 'one', applied), job('J5', 'two', applied), job('J5', 'three', applied)])
    expect(report.executed).toBe(3)
    expect(report.substitutedTo).toBe('mock')
    expect(applied).toEqual(['one:from-a', 'two:from-b', 'three:from-b'])
  })

  // An expired login will not fix itself on attempt two. It used to be an
  // ordinary failure: retried once per job, pushed into report.failed, and
  // report.failed was rendered nowhere — 2N doomed spawns and total silence.
  it('a dead login halts at once, without retrying, and says why', async () => {
    let calls = 0
    const applied: string[] = []
    const loggedOut = engineOf('claude', () => {
      calls++
      return deadLogin()
    })
    const runner = new JobRunner(paths, [loggedOut])
    const report = await runner.runAll([job('J1', 'one', applied), job('J5', 'two', applied)])
    expect(calls).toBe(1) // no retry, and the second job never dispatched
    expect(report.executed).toBe(0)
    expect(report.failed).toEqual([])
    expect(report.deferred).toBe(2)
    expect(report.haltReason).toBe('auth')
    // Deferred work is KEPT: a working engine picks both jobs up next time.
    const rerun = await new JobRunner(paths, [engineOf('mock', () => ok('r'))]).runAll([
      job('J1', 'one', applied),
      job('J5', 'two', applied),
    ])
    expect(rerun.executed).toBe(2)
  })

  it('names quota as the halt reason so the UI can say which pause this is', async () => {
    const report = await new JobRunner(paths, [engineOf('claude', quota)]).runAll([job('J1', 'one', [])])
    expect(report.haltReason).toBe('quota')
  })

  it('a substituted engine is not a halt — nothing to tell the user', async () => {
    const report = await new JobRunner(paths, [engineOf('claude', deadLogin), engineOf('mock', () => ok('r'))]).runAll([
      job('J1', 'one', []),
    ])
    expect(report.executed).toBe(1)
    expect(report.substitutedTo).toBe('mock')
    expect(report.haltReason).toBeUndefined()
  })

  it('429 with no substitute defers the remainder', async () => {
    const applied: string[] = []
    const engineA = engineOf('claude', quota)
    const runner = new JobRunner(paths, [engineA])
    const report = await runner.runAll([job('J1', 'one', applied), job('J5', 'two', applied)])
    expect(report.executed).toBe(0)
    expect(report.deferred).toBe(2)
    // deferred jobs are NOT journaled ??the next sweep picks them up
    const rerun = await new JobRunner(paths, [engineOf('mock', () => ok('r'))]).runAll([
      job('J1', 'one', applied),
      job('J5', 'two', applied),
    ])
    expect(rerun.executed).toBe(2)
  })
})

describe('job runner (concurrent pool)', () => {
  it('overlaps jobs up to the pool width and still executes them all', async () => {
    let inFlight = 0
    let peak = 0
    const slow: Engine = {
      id: 'mock',
      detect: async () => ({ installed: true, loggedIn: true }),
      async *run() {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        yield { type: 'result', text: 'r' } as EngineEvent
      },
    }
    const applied: string[] = []
    const runner = new JobRunner(paths, [slow], { concurrency: 3 })
    const report = await runner.runAll([job('J1', 'a', applied), job('J5', 'b', applied), job('J5', 'c', applied)])
    expect(report.executed).toBe(3)
    expect(peak).toBeGreaterThan(1) // genuinely overlapped
    expect(new Set(applied)).toEqual(new Set(['a:r', 'b:r', 'c:r']))
    // journal survives the pool: a rerun skips everything
    const rerun = await new JobRunner(paths, [slow], { concurrency: 3 }).runAll([
      job('J1', 'a', applied),
      job('J5', 'b', applied),
      job('J5', 'c', applied),
    ])
    expect(rerun.skipped).toBe(3)
  })

  it('concurrent quota hits advance the substitution pointer once and finish on the substitute', async () => {
    const engineA = engineOf('claude', quota) // every call 429s
    const engineB = engineOf('mock', () => ok('from-b'))
    const applied: string[] = []
    const runner = new JobRunner(paths, [engineA, engineB], { concurrency: 3 })
    const report = await runner.runAll([job('J1', 'x', applied), job('J5', 'y', applied), job('J5', 'z', applied)])
    expect(report.executed).toBe(3)
    expect(report.substitutedTo).toBe('mock')
    expect(new Set(applied)).toEqual(new Set(['x:from-b', 'y:from-b', 'z:from-b']))
  })

  it('stop under concurrency defers everything not yet dispatched', async () => {
    let stop = false
    const applied: string[] = []
    const gated: Engine = {
      id: 'mock',
      detect: async () => ({ installed: true, loggedIn: true }),
      async *run() {
        stop = true // first dispatched batch flips the stop flag
        await new Promise((r) => setTimeout(r, 10))
        yield { type: 'result', text: 'r' } as EngineEvent
      },
    }
    const runner = new JobRunner(paths, [gated], { concurrency: 2, shouldStop: () => stop })
    const report = await runner.runAll([
      job('J1', 'a', applied),
      job('J5', 'b', applied),
      job('J5', 'c', applied),
      job('J5', 'd', applied),
    ])
    // Workers dispatch a and b before either flips stop is observed; c and d
    // must defer. In-flight jobs complete and are journaled.
    expect(report.executed + report.deferred).toBe(4)
    expect(report.deferred).toBeGreaterThanOrEqual(2)
  })
})
