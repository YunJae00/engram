import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MockEngine } from '../src/engine/mock.js'
import { killAllEngineChildrenSync, liveEnginePids, spawnLines } from '../src/engine/spawn.js'
import { initVault } from '../src/vault.js'
import { JobRunner } from '../src/jobs/runner.js'
import { tmpVaultRoot } from './helpers.js'

async function script(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engram-timeout-'))
  const file = join(dir, 'script.cjs')
  await writeFile(file, body)
  return file
}

const drain = async (gen: ReturnType<typeof spawnLines>) => {
  const lines: string[] = []
  for (;;) {
    const { value, done } = await gen.next()
    if (done) return { lines, final: value }
    lines.push(value)
  }
}

afterEach(() => killAllEngineChildrenSync())

describe('the three enders', () => {
  it('total budget: a sleeper is killed at the deadline, marker in stderr', async () => {
    const file = await script('setInterval(function () {}, 1000)\n')
    const started = Date.now()
    const { final } = await drain(spawnLines('node', [file], { cwd: process.cwd(), timeoutMs: 400 }))
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(final.code).toBeNull()
    expect(final.stderr).toContain('[engram] timed out after 400ms')
  })

  it('idle watchdog: one line then silence dies as stalled, well inside the total budget', async () => {
    const file = await script('console.log("hello"); setInterval(function () {}, 1000)\n')
    const started = Date.now()
    // The window must outlive node's own boot (~0.5-1s on a cold win32 shim) —
    // production uses 120s; the point here is only that it beats the 60s total.
    const { lines, final } = await drain(
      spawnLines('node', [file], { cwd: process.cwd(), timeoutMs: 120_000, idleTimeoutMs: 5_000 }),
    )
    expect(lines).toContain('hello')
    expect(Date.now() - started).toBeLessThan(60_000)
    expect(final.stderr).toContain('[engram] stalled: no output for 5000ms')
  })

  it('abort: the caller cancels, the tree dies, the marker says canceled', async () => {
    const file = await script('setInterval(function () {}, 1000)\n')
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 200)
    const { final } = await drain(
      spawnLines('node', [file], { cwd: process.cwd(), timeoutMs: 30_000, signal: controller.signal }),
    )
    expect(final.code).toBeNull()
    expect(final.stderr).toContain('[engram] canceled')
    // Nothing lingers: the registry drains once the enders ran.
    await new Promise((r) => setTimeout(r, 300))
    expect(liveEnginePids()).toEqual([])
  })
})

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
