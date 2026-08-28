import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, sep } from 'node:path'
import { classifyEngineError, setCloudEngineFactory, type Engine, type EngineErrorKind } from 'core'
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

const need = createRequire(import.meta.url)

function resolvePackageDir(name: string): string | null {
  try {
    return dirname(need.resolve(`${name}/package.json`))
  } catch {
    return null
  }
}

export function claudeBinary(): string | null {
  const dir = resolvePackageDir(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`)
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
  const dir = resolvePackageDir(`@openai/codex-${key}`)
  if (!dir) return null
  const path = unpackedPath(join(dir, 'vendor', triple, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex'))
  return existsSync(path) ? path : null
}

export interface RunText {
  code: number | null
  out: string
}

// One command of the runtime, its output collected, ended after the budget.
export function runText(binary: string, args: string[], timeoutMs: number): Promise<RunText> {
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
      child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
