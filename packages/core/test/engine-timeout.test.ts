import { afterEach, describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import { killAllEngineChildrenSync } from '../src/engine/spawn.js'
import { initVault } from '../src/vault.js'
import { JobRunner } from '../src/jobs/runner.js'
import { tmpVaultRoot } from './helpers.js'



afterEach(() => killAllEngineChildrenSync())


describe('the runner retries a hang once, with a breather', () => {
  it('hang then success → executed; hang twice → failed', async () => {
    const paths = await initVault(await tmpVaultRoot('engine-timeout'), { git: false })
    const once = new MockEngine({ default: '{"ok":true}' }, { hangTimes: 1 })
    const runner = new JobRunner(paths, [once], { timeoutMs: 150, retryDelayMs: 0 })
    const report = await runner.runAll([
      { kind: 'J2', inputKey: 'a', instruction: 'x', prompt: 'JOB: default\nx', apply: async () => ['ok'] },
    ])
    expect(report.executed).toBe(1)
    expect(report.failed).toHaveLength(0)

    const always = new MockEngine({ default: '{"ok":true}' }, { hangTimes: 99 })
    const runner2 = new JobRunner(paths, [always], { timeoutMs: 150, retryDelayMs: 0 })
    const report2 = await runner2.runAll([
      { kind: 'J2', inputKey: 'b', instruction: 'x', prompt: 'JOB: default\nx', apply: async () => ['ok'] },
    ])
    expect(report2.executed).toBe(0)
    expect(report2.failed).toHaveLength(1)
  })
})
