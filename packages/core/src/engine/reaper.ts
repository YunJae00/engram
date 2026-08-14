import { spawn, spawnSync } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import type { SpawnObserver, SpawnedEngineProcess } from './spawn.js'

export interface LedgerEntry {
  pid: number
  startedAt: number
  cmd: string
}

// win32 process creation time drifts from Date.now() stamped in the parent —
// AV scans and disk pressure delay the child's real start (orca uses the same
// tolerance).
const CREATED_AT_TOLERANCE_MS = 10_000
const PROBE_TIMEOUT_MS = 5_000

async function readLedger(file: string): Promise<LedgerEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown
    return Array.isArray(parsed) ? (parsed as LedgerEntry[]).filter((e) => typeof e?.pid === 'number') : []
  } catch {
    return []
  }
}

// Atomic + no-op-skipping writer, serialized through a chain so a burst of
// spawns cannot interleave temp files (OneDrive-hosted userData throws EPERM
// on concurrent renames).
function ledgerWriter(file: string) {
  let last = ''
  let chain: Promise<void> = Promise.resolve()
  return (entries: LedgerEntry[]): void => {
    const body = JSON.stringify(entries)
    if (body === last) return
    last = body
    chain = chain.then(async () => {
      try {
        await writeFile(`${file}.tmp`, body)
        await rename(`${file}.tmp`, file)
      } catch {
        /* best-effort — a missed write means one extra probe next boot */
      }
    })
  }
}

// The observer the desktop injects at boot: mirrors the live registry into
// the ledger file. Loads what a crashed run left behind ONLY to preserve it —
// this process's entries are appended beside stale ones until the janitor
// adjudicates them.
export function createPidLedger(file: string): SpawnObserver {
  const mine = new Map<number, LedgerEntry>()
  let stale: LedgerEntry[] | null = null
  const write = ledgerWriter(file)
  const persist = (): void => {
    if (stale === null) return // not loaded yet — the load below persists
    write([...stale, ...mine.values()])
  }
  void readLedger(file).then((prior) => {
    stale = prior.filter((e) => !mine.has(e.pid))
    persist()
  })
  return {
    onSpawn(p: SpawnedEngineProcess): void {
      mine.set(p.pid, { pid: p.pid, startedAt: p.startedAt, cmd: p.cmd })
      persist()
    },
    onExit(pid: number): void {
      if (mine.delete(pid)) persist()
    },
  }
}

export interface ProcessProbe {
  // null = no process with that PID (already dead)
  inspect(pid: number): Promise<{ createdAt: number; commandLine: string | null } | null>
  kill(pid: number): void
}

// An engine invocation, recognizably: the program or our fixed flags. The
// check only ever RESTRAINS a kill — an unreadable command line falls back to
// the pid+time double check alone.
function looksLikeEngine(commandLine: string): boolean {
  return /claude|--output-format|--version|auth\s+status/i.test(commandLine)
}

function defaultProbe(): ProcessProbe {
  return {
    async inspect(pid) {
      if (process.platform === 'win32') {
        const script =
          `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
          `ForEach-Object { "$($_.ProcessId)\`t$([DateTimeOffset]::new($_.CreationDate.ToUniversalTime(),[TimeSpan]::Zero).ToUnixTimeMilliseconds())\`t$($_.CommandLine)" }`
        const out = await new Promise<string | null>((resolve) => {
          const child = spawn('powershell', ['-NoProfile', '-Command', script], { stdio: ['ignore', 'pipe', 'ignore'] })
          let text = ''
          const timer = setTimeout(() => {
            child.kill()
            resolve(null)
          }, PROBE_TIMEOUT_MS)
          child.stdout?.on('data', (c: Buffer) => (text += c.toString()))
          child.on('error', () => {
            clearTimeout(timer)
            resolve(null)
          })
          child.on('close', () => {
            clearTimeout(timer)
            resolve(text)
          })
        })
        if (out === null) throw new Error('probe timed out')
        const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(String(pid)))
        if (!line) return null
        const [, ts, ...rest] = line.split('\t')
        const createdAt = Number(ts)
        if (!Number.isFinite(createdAt)) throw new Error('unparseable creation time')
        return { createdAt, commandLine: rest.join('\t') || null }
      }
      try {
        process.kill(pid, 0)
      } catch {
        return null
      }
      // POSIX: creation time via ps; a parse failure throws (= leave alone).
      const out = spawnSync('ps', ['-o', 'lstart=,command=', '-p', String(pid)], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
      if (out.status !== 0) return null
      const text = out.stdout.trim()
      if (!text) return null
      const createdAt = Date.parse(text.slice(0, 24))
      if (!Number.isFinite(createdAt)) throw new Error('unparseable lstart')
      return { createdAt, commandLine: text.slice(24).trim() || null }
    },
    kill(pid) {
      if (process.platform === 'win32') {
        try {
          spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 2_000 })
        } catch {
          /* fall through */
        }
        return
      }
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* already gone */
      }
    },
  }
}

// Boot janitor: adjudicate every ledgered PID. Best-effort and bounded —
// never allowed to slow or block a boot (callers fire-and-forget).
export async function sweepStaleEnginePids(
  file: string,
  probe: ProcessProbe = defaultProbe(),
): Promise<{ killed: number[]; released: number[] }> {
  const entries = await readLedger(file)
  if (entries.length === 0) return { killed: [], released: [] }
  const killed: number[] = []
  const released: number[] = []
  const keep: LedgerEntry[] = []
  for (const entry of entries) {
    let alive
    try {
      alive = await probe.inspect(entry.pid)
    } catch {
      // Could not find out — keep the entry for the next boot, touch nothing.
      keep.push(entry)
      continue
    }
    if (alive === null) {
      released.push(entry.pid) // already dead — just bookkeeping
      continue
    }
    const sameBirth = Math.abs(alive.createdAt - entry.startedAt) <= CREATED_AT_TOLERANCE_MS
    const engineish = alive.commandLine === null || looksLikeEngine(alive.commandLine)
    if (sameBirth && engineish) {
      probe.kill(entry.pid)
      killed.push(entry.pid)
    } else {
      // PID reused by someone else's process — release, NEVER kill.
      released.push(entry.pid)
    }
  }
  const write = ledgerWriter(file)
  write(keep)
  return { killed, released }
}
