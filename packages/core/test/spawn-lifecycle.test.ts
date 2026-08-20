import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  killAllEngineChildrenSync,
  killTree,
  liveEnginePids,
  probeCli,
  setSpawnObserver,
  spawnServerChild,
  type SpawnedEngineProcess,
} from '../src/engine/spawn.js'

// A sleeper the shell-safety gate accepts: argv is just a file path, no
// cmd.exe metacharacters (node -e "setInterval(...)" would be rejected on
// win32 by assertShellSafeArgs — parentheses are shell meta).
async function sleeperScript(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'engram-sleeper-'))
  const file = join(dir, 'sleeper.cjs')
  // The file's CONTENT is free to use any syntax — only argv passes the
  // shell-safety gate, and argv here is just this path.
  await writeFile(file, 'setInterval(function () {}, 1000)\n')
  return file
}

const dead = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (check()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return check()
}

afterEach(() => {
  setSpawnObserver(null)
  killAllEngineChildrenSync()
})

describe('engine child registry', () => {
  it('a spawned child appears in the registry and leaves it on exit', async () => {
    const file = await sleeperScript()
    const events: string[] = []
    setSpawnObserver({
      onSpawn: (p: SpawnedEngineProcess) => {
        events.push(`spawn:${p.pid}`)
        // Diagnostics label carries the program and flags, never a prompt.
        expect(p.cmd).toContain('node')
        expect(Math.abs(Date.now() - p.startedAt)).toBeLessThan(5_000)
      },
      onExit: (pid: number) => events.push(`exit:${pid}`),
    })
    const child = spawnServerChild('node', [file], process.cwd())
    expect(await until(() => liveEnginePids().length > 0)).toBe(true)
    killTree(child)
    expect(await until(() => liveEnginePids().length === 0)).toBe(true)
    expect(events.some((e) => e.startsWith('spawn:'))).toBe(true)
    expect(events.some((e) => e.startsWith('exit:'))).toBe(true)
  })

  it('AN OBSERVER THAT THROWS NEVER BREAKS THE SPAWN PATH', async () => {
    const file = await sleeperScript()
    setSpawnObserver({
      onSpawn: () => {
        throw new Error('observer bug')
      },
      onExit: () => {
        throw new Error('observer bug')
      },
    })
    // The spawn itself survives an exploding observer; so does the teardown.
    const child = spawnServerChild('node', [file], process.cwd())
    expect(child.pid).toBeGreaterThan(0)
    killTree(child)
    expect(await until(() => liveEnginePids().length === 0)).toBe(true)
  })

  it('killAllEngineChildrenSync ends every live child before returning', async () => {
    const file = await sleeperScript()
    spawnServerChild('node', [file], process.cwd())
    spawnServerChild('node', [file], process.cwd())
    expect(await until(() => liveEnginePids().length >= 2)).toBe(true)
    const pids = liveEnginePids()
    const killed = killAllEngineChildrenSync()
    expect(killed).toBeGreaterThanOrEqual(2)
    expect(await until(() => pids.every(dead), 2_000)).toBe(true)
  })

  it('a timed-out probe answers null and leaves no live child behind', async () => {
    const file = await sleeperScript()
    const verdict = await probeCli('node', [file], 500)
    expect(verdict).toBeNull()
    // The probe's own child (the shim on win32) must be gone from the
    // registry — the grandchild's death rides taskkill /T.
    expect(await until(() => liveEnginePids().length === 0, 2_000)).toBe(true)
  })
})
