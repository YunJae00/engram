import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import os from 'node:os'

export interface SpawnedEngineProcess {
  pid: number
  // Program + flags only, for diagnostics. Never the prompt — prompts travel
  // by stdin, and the filter below drops any non-flag argv defensively.
  cmd: string
  // Date.now() at spawn — the janitor's PID-reuse guard material.
  startedAt: number
}

export interface SpawnObserver {
  onSpawn(p: SpawnedEngineProcess): void
  onExit(pid: number): void
}

let observer: SpawnObserver | null = null
const live = new Map<number, ChildProcess>()

export function setSpawnObserver(next: SpawnObserver | null): void {
  observer = next
}

export function liveEnginePids(): number[] {
  return [...live.keys()]
}

function track(child: ChildProcess, cmd: string, args: string[], lowPriority = true): void {
  const pid = child.pid
  if (pid === undefined) return
  live.set(pid, child)
  if (!lowPriority) return trackRest(child, pid, cmd, args)
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    /* a process that already exited, or a platform that refuses — not worth an error */
  }
  return trackRest(child, pid, cmd, args)
}

function trackRest(child: ChildProcess, pid: number, cmd: string, args: string[]): void {
  const label = [cmd, ...args.filter((a) => a.startsWith('-'))].join(' ').slice(0, 120)
  // Observer callbacks must never throw into a spawn path.
  try {
    observer?.onSpawn({ pid, cmd: label, startedAt: Date.now() })
  } catch {
    /* observer's problem, not the spawn's */
  }
  // 'exit' and 'close' can arrive in either order (win32 sometimes stalls
  // 'close' behind stream teardown) — untrack on whichever lands first.
  const untrack = () => {
    if (!live.delete(pid)) return
    try {
      observer?.onExit(pid)
    } catch {
      /* same */
    }
  }
  child.on('exit', untrack)
  child.on('close', untrack)
  child.on('error', untrack)
}

// Synchronous by design — its one caller is will-quit, where the event loop
// is about to end and the kills must complete before this returns. Bounded: a
// wedged taskkill must never hold the app's exit hostage (500ms per PID).
export function killAllEngineChildrenSync(): number {
  let count = 0
  for (const [pid, child] of live) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 500, windowsHide: true })
      } catch {
        /* fall through to SIGKILL */
      }
    }
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    count += 1
  }
  return count
}

// npm-installed CLIs on Windows are .cmd shims — Node refuses to spawn those
// without a shell. Our argv stays fixed/flag-only whenever shell mode is on
// (prompts go via stdin), so this is quoting-safe.
const NEEDS_SHELL = process.platform === 'win32'

const shellSafe = (cmd: string): string => (NEEDS_SHELL ? `"${cmd}"` : cmd)

// Under shell mode Node concatenates argv into the command line WITHOUT
// escaping (Node's own DEP0190 warns about exactly this). Today that is safe
// because the prompt travels by stdin and argv is fixed flags — but only
// because ClaudeAdapter's `viaStdin` and this file's NEEDS_SHELL happen to be
// the same expression, kept in step by a comment. One future arg carrying user
// text would be command injection, and nothing would have failed first.
//
// So the invariant becomes a checked precondition, like safeInboxName and
// notePath: on the shell path every argument must be free of cmd.exe
// metacharacters. Flags, model aliases and paths pass; a prompt or anything
// carrying `& | > < ^ " ' ( ) %` or a newline throws at the call site instead
// of reaching the shell.
const SHELL_META = /["'&|<>^%`\r\n]/

function assertShellSafeArgs(cmd: string, args: string[]): void {
  if (!NEEDS_SHELL) return
  for (const arg of args) {
    if (SHELL_META.test(arg)) {
      throw new Error(
        `unsafe argv for shell-mode spawn of ${cmd}: ${JSON.stringify(arg.slice(0, 60))} — pass user text via stdin, not argv`,
      )
    }
  }
}

// child.kill() is not enough under shell mode. On win32 the CLI is a
// GRANDCHILD of cmd.exe, and Node's kill calls TerminateProcess on cmd.exe
// alone — the grandchild survives, still holding the inherited stdout write
// handle, so the reader never sees EOF and a "timeout" times nothing out.
// taskkill /T ends the tree. Best-effort by design: a reap that fails must
// never throw into a caller's error path.
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
    } catch {
      /* taskkill missing — the SIGKILL below is the fallback */
    }
  }
  child.kill('SIGKILL')
}
export function spawnServerChild(cmd: string, args: string[], cwd: string): ChildProcess {
  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env },
    stdio: 'ignore',
    windowsHide: true,
  })
  track(child, cmd, args)
  return child
}

export function probeCli(cmd: string, args: string[] = ['--version'], timeoutMs = 10_000): Promise<boolean | null> {
  return new Promise((resolve) => {
    // OUTSIDE the try: unsafe argv is a bug in the caller, not a missing CLI.
    // Swallowing it into resolve(false) would report "this engine is not
    // installed" — the same silent-failure shape this pass is removing.
    assertShellSafeArgs(cmd, args)
    let child
    try {
      child = spawn(shellSafe(cmd), args, { stdio: 'ignore', shell: NEEDS_SHELL, windowsHide: true })
    } catch {
      resolve(false)
      return
    }
    track(child, cmd, args, false)
    const timer = setTimeout(() => {
      killTree(child)
      resolve(null)
    }, timeoutMs)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

// Every error leaving an adapter carries its kind, classified here where the
