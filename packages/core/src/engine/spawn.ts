import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { classifyEngineError } from './classify.js'
import type { EngineEvent } from './types.js'

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

interface SpawnStreamOptions {
  cwd: string
  timeoutMs: number
  env?: Record<string, string>
  // Written to the child's stdin, then closed. Engine prompts travel this
  // way on Windows so shell-mode spawning never sees user text in argv.
  stdin?: string
  // Abort → tree kill + `[engram] canceled` stderr marker. The adapter turns
  // that marker into a silent end, not an error.
  signal?: AbortSignal
  // Stdout-silence watchdog: reset on every chunk; expiry kills the tree with
  // an `[engram] stalled` marker. stream-json emits an init line immediately,
  // so a healthy call can never trip this while "thinking".
  idleTimeoutMs?: number
  // Long WORK yields to the user; short QUESTIONS (auth status) must not be
  // starved into a false "cannot ask". See track().
  lowPriority?: boolean
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

// The one door for a LONG-LIVED engine child (the warm chat session). Same
// safety rails as spawnLines — shell-safe argv, registry+ledger tracking —
// but stdin stays open and the lifecycle belongs to the caller. Everything
// else (kill discipline, quit reaping) treats it like any other child.
export function spawnEngineChild(
  cmd: string,
  args: string[],
  cwd: string,
): ChildProcess {
  assertShellSafeArgs(cmd, args)
  const child = spawn(shellSafe(cmd), args, {
    cwd,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: NEEDS_SHELL,
    windowsHide: true,
  })
  track(child, cmd, args)
  return child
}

// A long-lived local SERVER (llama.cpp): spawned DIRECTLY, no shell — the
// executable is a real .exe (shell mode exists for npm .cmd shims) and its
// argv carries filesystem paths that may contain spaces, which cmd.exe's
// unquoted join would tear apart. Tracked like every other engine child.
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

// Runs a CLI and yields stdout line by line; kills the process on timeout.
export async function* spawnLines(
  cmd: string,
  args: string[],
  options: SpawnStreamOptions,
): AsyncGenerator<string, { code: number | null; stderr: string }> {
  assertShellSafeArgs(cmd, args)
  const child = spawn(shellSafe(cmd), args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: [options.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    shell: NEEDS_SHELL,
    windowsHide: true,
  })
  track(child, cmd, args, options.lowPriority ?? true)
  if (options.stdin !== undefined && child.stdin) {
    child.stdin.write(options.stdin)
    child.stdin.end()
  }
  // stdio config above always pipes these; the union type just can't see it
  if (!child.stdout || !child.stderr) throw new Error(`failed to open pipes for ${cmd}`)
  const stdout = child.stdout
  // setEncoding routes chunks through Node's boundary-safe string decoder.
  // Decoding each chunk separately (Buffer.toString per chunk) corrupts any
  // multibyte character that a chunk boundary splits — long Korean outputs
  // (image transcriptions, chat answers) came back with U+FFFD garbage.
  stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  // Every early ending must end the STREAM, not just the process: the loop
  // below awaits EOF on stdout, and killing the (grand)child alone left that
  // await pending forever — the 300s "timeout" never actually stopped a hung
  // call. Three enders share one shape: total budget, stdout-silence watchdog,
  // and caller cancellation. Whichever fires first stamps `ended` and the
  // stream finishes with its marker in stderr.
  let ended: string | null = null
  const end = (marker: string): void => {
    if (ended !== null) return
    ended = marker
    killTree(child)
    stdout.destroy()
  }
  // A spawn that never starts (ENOENT, EACCES) emits 'error' and nothing else:
  // no exit, no stdout close. Without this listener the stream waits for a
  // process that does not exist, and an unhandled 'error' throws on top.
  child.on('error', (err: Error) => end(`[engram] spawn failed: ${err.message}`))
  const timer = setTimeout(() => end(`[engram] timed out after ${options.timeoutMs}ms`), options.timeoutMs)
  let idleTimer: NodeJS.Timeout | undefined
  const armIdle = (): void => {
    if (options.idleTimeoutMs === undefined) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => end(`[engram] stalled: no output for ${options.idleTimeoutMs}ms`), options.idleTimeoutMs)
  }
  armIdle()
  const onAbort = (): void => end('[engram] canceled')
  if (options.signal?.aborted) onAbort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let stderr = ''
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
  })

  let buffer = ''
  try {
    try {
      for await (const chunk of stdout) {
        armIdle()
        buffer += chunk as string
        let idx = buffer.indexOf('\n')
        while (idx !== -1) {
          yield buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          idx = buffer.indexOf('\n')
        }
      }
    } catch (err) {
      // destroy() above surfaces as a premature-close read error; that is our
      // own doing, so report it as the ending it is. Anything else is real.
      if (ended === null) throw err
    }
    if (buffer.length > 0) yield buffer
    // Exit code null + the marker is what the adapter classifies — timeout
    // and stall become error events, a cancel becomes a silent end.
    if (ended !== null) return { code: null, stderr: `${stderr}\n${ended}` }
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve))
    return { code, stderr }
  } finally {
    clearTimeout(timer)
    if (idleTimer) clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', onAbort)
    killTree(child)
  }
}

// detect() helper: does `cmd --version`-style probe exit zero?
// THREE answers, and the third is the one that matters:
//   true  → ran and exited 0: it is there
//   false → spawn refused (ENOENT) or a non-zero exit: it is really not usable
//   null  → we could not find out (timed out). NOT the same as absent.
//
// The distinction exists because the caller drops an engine from the usable
// list on `false`, and detection runs every 10 minutes for the life of the
// process. A probe that merely ran slowly — laptop resuming from sleep, a
// virus scanner on the .cmd shim, the machine busy — used to read as "Claude
// is gone", which is what a user experiences as the connection dropping by
// itself. Measured on an idle machine this probe takes ~1.1s; the budget is
// there for the bad minutes, and overrunning it now says "unknown".
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
// exit code is still in hand — the UI four layers up cannot recover it.
export function errorEvent(message: string, exitCode?: number | null): EngineEvent {
  return { type: 'error', message, kind: classifyEngineError(message, exitCode) }
}
