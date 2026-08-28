import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyEngineError, setCloudEngineFactory, type Engine, type EngineDetection, type EngineErrorKind } from 'core'
import { ClaudeEngine } from './engine-claude.js'
import { CodexEngine } from './engine-codex.js'

// The two cloud brains, each behind the vendor's own command-line runtime that
// ships inside this app. The person signs in through the vendor's own flow
// and pays the vendor; this app never sees, stores or forwards a credential -
// it only asks the runtime whether one exists and hands it the work.

export type CloudEngineId = 'claude' | 'codex'

// A file that lives inside the archive is only runnable from its unpacked
// twin; the archive path is what module resolution hands back.
export function unpackedPath(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

// The platform package that holds a runtime is a dependency of the vendor's
// SDK package, not of this app: it sits beside the SDK's own folder, wherever
// the package manager put that. The SDK's entry file is what can be resolved
// from here; the runtime is found relative to it.
// Where the files really are, when that can be asked; the path itself when
// it cannot (inside the app archive).
function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

// The SDK's folder, found the way a module loader would look for it - up from
// this file through every node_modules - without going through the package's
// own export map, which one of the SDKs closes to everything but its entry.
function sdkRoot(name: string): string | null {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(candidate)) return real(candidate)
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

// A package the SDK depends on lives beside the SDK's own folder, once links
// are followed to where the files really are.
function sibling(root: string, name: string): string | null {
  const candidate = join(dirname(root), name)
  return existsSync(candidate) ? real(candidate) : null
}

export function claudeBinary(): string | null {
  const sdk = sdkRoot('@anthropic-ai/claude-agent-sdk')
  const dir = sdk && sibling(sdk, `claude-agent-sdk-${process.platform}-${process.arch}`)
  if (!dir) return null
  const path = unpackedPath(join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'))
  return existsSync(path) ? path : null
}

const CODEX_TRIPLE: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

export function codexBinary(): string | null {
  const key = `${process.platform}-${process.arch}`
  const triple = CODEX_TRIPLE[key]
  if (!triple) return null
  // SDK → the vendor's launcher package beside it → the platform package
  // beside that, each a dependency of the one before.
  const sdk = sdkRoot('@openai/codex-sdk')
  const launcher = sdk && sibling(sdk, 'codex')
  const dir = launcher && sibling(launcher, `codex-${key}`)
  if (!dir) return null
  const path = unpackedPath(join(dir, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'))
  return existsSync(path) ? path : null
}

export interface RunText {
  code: number | null
  out: string
}

// The runtime's helpers (its own search tool among them) sit in a folder
// beside its binary and are found through PATH. Handing the runtime a path of
// our own means handing it that folder too.
export function withHelpersOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const helpers = join(dirname(dirname(binary)), 'codex-path')
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  out[key] = out[key] ? `${helpers}${delimiter}${out[key]}` : helpers
  return out
}

// One command of the runtime, its output collected, ended after the budget.
export function runText(binary: string, args: string[], timeoutMs: number, env?: Record<string, string>): Promise<RunText> {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ code, out })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}) })
    } catch (err) {
      out = err instanceof Error ? err.message : String(err)
      resolve({ code: null, out })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.stderr?.on('data', (chunk: Buffer) => (out += chunk.toString()))
    child.on('error', (err) => {
      out += err.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

// What a failed call means: the vendor's runtime says it in words, and the
// remedy differs - sign in again, wait for a limit, or report a crash.
export function cloudErrorKind(message: string): EngineErrorKind {
  if (/not logged in|not authenticated|log ?in|sign ?in|invalid api key|unauthorized|\b40[13]\b/i.test(message)) return 'auth'
  if (/rate limit|too many requests|\b429\b|quota|usage limit|extra usage|credit/i.test(message)) return 'quota'
  return classifyEngineError(message)
}

export const LOGIN_TIMEOUT_MS = 5 * 60_000
export const STATUS_TIMEOUT_MS = 15_000
// A sign-in that was there a minute ago is still there: detection is asked
// on every focus and by every poll, and each ask is a process.
export const STATUS_TTL_MS = 60_000

// One probe at a time, and a positive answer kept for a minute. A negative
// one is asked again next time - that is the state the person is fixing.
export class StatusCache {
  private probing: Promise<EngineDetection> | null = null
  private known: { at: number; detection: EngineDetection } | null = null

  async read(probe: () => Promise<EngineDetection>, now = Date.now()): Promise<EngineDetection> {
    if (this.known?.detection.loggedIn && now - this.known.at < STATUS_TTL_MS) return this.known.detection
    if (this.probing) return this.probing
    this.probing = probe().finally(() => {
      this.probing = null
    })
    const detection = await this.probing
    this.known = { at: now, detection }
    return detection
  }

  forget(): void {
    this.known = null
  }
}

export interface CloudEngine extends Engine {
  readonly id: CloudEngineId
  readonly label: string
  login(): Promise<{ ok: boolean; message?: string }>
  logout(): Promise<void>
}

const instances = new Map<CloudEngineId, CloudEngine>()

export function cloudEngine(id: CloudEngineId): CloudEngine {
  let engine = instances.get(id)
  if (!engine) {
    engine = id === 'claude' ? new ClaudeEngine() : new CodexEngine()
    instances.set(id, engine)
  }
  return engine
}

export function installCloudEngines(): void {
  setCloudEngineFactory((id) => cloudEngine(id))
}
