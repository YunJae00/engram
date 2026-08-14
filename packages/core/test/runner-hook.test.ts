import { beforeEach, describe, expect, it } from 'vitest'
import type { Engine, EngineEvent } from '../src/engine/types.js'
import { JobRunner, type JobSpec } from '../src/jobs/runner.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// Trivial fake engine that always succeeds — same shape as runner.test.ts's
// engineOf, minus the per-prompt handler (the hook doesn't care about output).
function fakeEngine(): Engine {
  return {
    id: 'mock' as Engine['id'],
    detect: async () => ({ installed: true, loggedIn: true }),
    async *run() {
      yield { type: 'result', text: 'ok' } as EngineEvent
    },
  }
}

function job(kind: 'J1' | 'J3' | 'J5', key: string): JobSpec {
  return {
    kind,
    inputKey: key,
    instruction: `INSTRUCTION: ${kind}`,
    prompt: `JOB: ${kind}\n${key}`,
    apply: async () => [`applied ${key}`],
  }
}

let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('runner-hook'), { git: false })
})

describe('runner onJobStart hook', () => {
  it('fires once per executed job with (job, index, total), in order', async () => {
    const seen: Array<[string, number, number]> = []
    const runner = new JobRunner(paths, [fakeEngine()], { onJobStart: (j, index, total) => seen.push([j, index, total]) })
    const report = await runner.runAll([job('J1', 'a'), job('J3', 'b'), job('J5', 'c')])
    expect(report.executed).toBe(3)
    expect(seen).toEqual([
      ['J1', 1, 3],
      ['J3', 2, 3],
      ['J5', 3, 3],
    ])
  })

  it('does not fire for journal-skipped jobs (only for jobs that execute)', async () => {
    const jobs = [job('J1', 'a'), job('J3', 'b')]
    await new JobRunner(paths, [fakeEngine()]).runAll(jobs) // populate the journal
    const seen: string[] = []
    const rerun = await new JobRunner(paths, [fakeEngine()], { onJobStart: (j) => seen.push(j) }).runAll(jobs)
    expect(rerun.skipped).toBe(2)
    expect(seen).toEqual([])
  })

  it('shouldStop after the first job defers the remaining jobs', async () => {
    const seen: string[] = []
    // Stops before the second job: false on the first check, true thereafter.
    const runner = new JobRunner(paths, [fakeEngine()], {
      onJobStart: (j) => seen.push(j),
      shouldStop: () => seen.length >= 1,
    })
    const report = await runner.runAll([job('J1', 'a'), job('J3', 'b'), job('J5', 'c')])
    expect(seen).toEqual(['J1'])
    expect(report.executed).toBe(1)
    expect(report.deferred).toBe(2)
  })
})
