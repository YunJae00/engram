import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import os from 'node:os'

export interface SpawnedEngineProcess {
  pid: number
  cmd: string
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
  }
  return trackRest(child, pid, cmd, args)
}

function trackRest(child: ChildProcess, pid: number, cmd: string, args: string[]): void {
  const label = [cmd, ...args.filter((a) => a.startsWith('-'))].join(' ').slice(0, 120)
  try {
    observer?.onSpawn({ pid, cmd: label, startedAt: Date.now() })
  } catch {
  }
  const untrack = () => {
    if (!live.delete(pid)) return
    try {
      observer?.onExit(pid)
    } catch {
    }
  }
  child.on('exit', untrack)
  child.on('close', untrack)
  child.on('error', untrack)
}

export function killAllEngineChildrenSync(): number {
  let count = 0
  for (const [pid, child] of live) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 500, windowsHide: true })
      } catch {
      }
    }
    try {
      child.kill('SIGKILL')
    } catch {
    }
    count += 1
  }
  return count
}

// npm CLIs on Windows are .cmd shims, which Node spawns only through a shell; argv is flags only there.
const NEEDS_SHELL = process.platform === 'win32'

const shellSafe = (cmd: string): string => (NEEDS_SHELL ? `"${cmd}"` : cmd)

// Node does not escape argv in shell mode, so cmd.exe metacharacters would be command injection.
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

export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
    } catch {
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
