import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { createPidLedger, sweepStaleEnginePids, type LedgerEntry, type ProcessProbe } from '../src/engine/reaper.js'

// The janitor kills from a FILE, possibly days old, so every test here is
// about the fail-open discipline: a PID dies only when the process exists AND
// its birth time matches the ledger AND its command line (when readable)
// looks like an engine. Every disagreement releases; only agreement kills.

const T = 1_753_900_000_000

let file: string
beforeEach(async () => {
  file = join(await mkdtemp(join(tmpdir(), 'engram-reaper-')), 'engine-pids.json')
})

const ledger = (...entries: LedgerEntry[]) => writeFile(file, JSON.stringify(entries))

// The ledger writer flushes through an async chain — poll the DISK state
// rather than guessing a sleep that a loaded machine will outrun.
const ledgerPids = async (): Promise<number[]> => {
  try {
    return (JSON.parse(await readFile(file, 'utf8')) as LedgerEntry[]).map((e) => e.pid)
  } catch {
    return [-1]
  }
}
// 30s, not 10: under a loaded full-suite run (90 files in parallel) the
// serialized write chain can lose the disk race for longer than any single
// reasonable window — the poll is cheap, the flake was not (3x on 08-06).
const until = async (check: () => Promise<boolean>, ms = 30_000): Promise<void> => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
}

function probeOf(
  answers: Record<number, { createdAt: number; commandLine: string | null } | null | 'throw'>,
): ProcessProbe & { killedPids: number[] } {
  const killedPids: number[] = []
  return {
    killedPids,
    async inspect(pid) {
      const answer = answers[pid]
      if (answer === 'throw') throw new Error('probe blind')
      return answer ?? null
    },
    kill(pid) {
      killedPids.push(pid)
    },
  }
}

describe('sweepStaleEnginePids', () => {
  it('kills only on full agreement: alive + same birth + engine-looking', async () => {
    await ledger({ pid: 100, startedAt: T, cmd: 'claude --output-format stream-json' })
    const probe = probeOf({ 100: { createdAt: T + 3_000, commandLine: 'claude --output-format stream-json' } })
    const { killed, released } = await sweepStaleEnginePids(file, probe)
    expect(killed).toEqual([100])
    expect(released).toEqual([])
    expect(probe.killedPids).toEqual([100])
  })

  it('A REUSED PID IS RELEASED, NEVER KILLED — birth time is the guard', async () => {
    await ledger({ pid: 100, startedAt: T, cmd: 'claude' })
    const probe = probeOf({ 100: { createdAt: T + 60_000, commandLine: 'claude' } })
    const { killed, released } = await sweepStaleEnginePids(file, probe)
    expect(killed).toEqual([])
    expect(released).toEqual([100])
    expect(probe.killedPids).toEqual([])
  })

  it('a command line that reads as someone else restrains the kill', async () => {
    await ledger({ pid: 100, startedAt: T, cmd: 'claude' })
    const probe = probeOf({ 100: { createdAt: T + 1_000, commandLine: 'notepad.exe important.txt' } })
    const { killed, released } = await sweepStaleEnginePids(file, probe)
    expect(killed).toEqual([])
    expect(released).toEqual([100])
  })

  it('an unreadable command line falls back to the pid+time double check', async () => {
    await ledger({ pid: 100, startedAt: T, cmd: 'claude' })
    const probe = probeOf({ 100: { createdAt: T + 1_000, commandLine: null } })
    expect((await sweepStaleEnginePids(file, probe)).killed).toEqual([100])
  })

  it('already-dead entries are released and the ledger empties', async () => {
    await ledger({ pid: 100, startedAt: T, cmd: 'claude' }, { pid: 101, startedAt: T, cmd: 'claude' })
    const probe = probeOf({ 100: null, 101: null })
    const { killed, released } = await sweepStaleEnginePids(file, probe)
    expect(killed).toEqual([])
    expect(released.sort()).toEqual([100, 101])
    await new Promise((r) => setTimeout(r, 100))
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([])
  })

  it('a blind probe keeps the entry for the next boot and touches nothing', async () => {
    await ledger({ pid: 100, startedAt: T, cmd: 'claude' })
    const probe = probeOf({ 100: 'throw' })
    const { killed, released } = await sweepStaleEnginePids(file, probe)
    expect(killed).toEqual([])
    expect(released).toEqual([])
    await new Promise((r) => setTimeout(r, 100))
    expect((JSON.parse(await readFile(file, 'utf8')) as LedgerEntry[]).map((e) => e.pid)).toEqual([100])
  })
})

describe('createPidLedger', () => {
  it('a spawn/exit round trip leaves the ledger empty on disk', async () => {
    const observer = createPidLedger(file)
    await new Promise((r) => setTimeout(r, 50)) // let the prior-load settle
    observer.onSpawn({ pid: 500, cmd: 'claude --version', startedAt: Date.now() })
    await until(async () => (await ledgerPids()).includes(500))
    expect((JSON.parse(await readFile(file, 'utf8')) as LedgerEntry[]).map((e) => e.pid)).toEqual([500])
    observer.onExit(500)
    await until(async () => (await ledgerPids()).length === 0)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([])
  })

  it('entries a crashed run left behind survive beside the new ones', async () => {
    await ledger({ pid: 900, startedAt: T, cmd: 'claude' })
    const observer = createPidLedger(file)
    await new Promise((r) => setTimeout(r, 100))
    observer.onSpawn({ pid: 901, cmd: 'claude', startedAt: Date.now() })
    await until(async () => (await ledgerPids()).length === 2)
    const pids = (JSON.parse(await readFile(file, 'utf8')) as LedgerEntry[]).map((e) => e.pid).sort()
    expect(pids).toEqual([900, 901])
  })
})
