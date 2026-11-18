import { gateModelCalls } from './model-call-gate.js'
import { ProcessClient } from './process-client.js'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { classifyEngineError, setCloudEngineFactory, type Engine, type EngineDetection, type EngineErrorKind } from 'core'
import { ClaudeEngine } from './engine-claude.js'
import { CodexEngine } from './engine-codex.js'
import { installedClaudeBinary } from './claude-runtime.js'
import { activeAccountProfile } from './account-profiles.js'

export type CloudEngineId = 'claude' | 'codex'

export function unpackedPath(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

function real(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

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

function sibling(root: string, name: string): string | null {
  const candidate = join(dirname(root), name)
  return existsSync(candidate) ? real(candidate) : null
}

export function claudeBinary(): string | null {
  return installedClaudeBinary()
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
  err: string
}

export function withHelpersOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const helpers = join(dirname(dirname(binary)), 'codex-path')
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  out[key] = out[key] ? `${helpers}${delimiter}${out[key]}` : helpers
  return out
}

export function runText(binary: string, args: string[], timeoutMs: number, env?: Record<string, string>, login?: CloudLoginOptions): Promise<RunText> {
  login?.signal?.throwIfAborted()
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (code: number | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      login?.signal?.removeEventListener('abort', cancel)
      resolve({ code, out, err })
    }
    let child: ProcessClient
    try {
      child = new ProcessClient(binary, args, { env })
      child.stdin.end()
    } catch (error) {
      resolve({ code: null, out: '', err: error instanceof Error ? error.message : String(error) })
      return
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    const cancel = (): void => { child.kill(); finish(null) }
    login?.signal?.addEventListener('abort', cancel, { once: true })
    const receive = (stream: 'out' | 'err') => (chunk: Buffer): void => {
      const next = (stream === 'out' ? out : err) + chunk.toString()
      if (stream === 'out') out = next.slice(-65536)
      else err = next.slice(-65536)
      if (login?.onUrl) for (const url of chunk.toString().match(/https:\/\/[\w./?=&%+~:#@!-]+/g) ?? []) login.onUrl(url)
    }
    child.stdout?.on('data', receive('out'))
    child.stderr?.on('data', receive('err'))
    child.on('error', (error) => {
      err += error.message
      finish(null)
    })
    child.on('close', (code) => finish(code))
  })
}

export function commandText(result: RunText): string {
  return `${result.out ?? ''}${result.err ?? ''}`
}

export function cloudErrorKind(message: string): EngineErrorKind {
  if (/not logged in|not authenticated|log ?in|sign ?in|invalid api key|unauthorized|\b40[13]\b/i.test(message)) return 'auth'
  if (/rate limit|too many requests|\b429\b|quota|usage limit|(?:insufficient|exhausted|not enough|out of) credits?/i.test(message)) return 'quota'
  return classifyEngineError(message)
}

export const LOGIN_TIMEOUT_MS = 5 * 60_000
export const STATUS_TIMEOUT_MS = 15_000
export const STATUS_TTL_MS = 60_000

export class StatusCache {
  private probing: Promise<EngineDetection> | null = null
  private known: { at: number; detection: EngineDetection } | null = null
  private generation = 0

  async read(probe: () => Promise<EngineDetection>, now = Date.now()): Promise<EngineDetection> {
    if (this.known && this.known.detection.installed && this.known.detection.conclusive !== false && now - this.known.at < STATUS_TTL_MS) return this.known.detection
    if (this.probing) return this.probing
    const generation = this.generation
    const pending = probe().then(detection => {
      if (generation !== this.generation) return this.known?.detection ?? { installed: detection.installed, loggedIn: false, conclusive: false }
      this.known = { at: now, detection }
      return detection
    }).finally(() => {
      if (this.probing === pending) this.probing = null
    })
    this.probing = pending
    return pending
  }

  forget(): void {
    this.known = null
    this.probing = null
    this.generation++
  }

  set(detection: EngineDetection, now = Date.now()): void {
    this.forget()
    this.known = { at: now, detection }
  }
}

export interface CloudEngine extends Engine {
  readonly id: CloudEngineId
  readonly label: string
  login(options?: CloudLoginOptions): Promise<{ ok: boolean; message?: string }>
  logout(): Promise<void>
  forgetStatus?(): void
  confirmAuth?(): void
}

export interface CloudLoginOptions { signal?: AbortSignal; onUrl?: (url: string) => void }

const instances = new Map<string, CloudEngine>()

export function cloudEngine(id: CloudEngineId, profile = activeAccountProfile(id)): CloudEngine {
  const key = `${id}:${profile}`
  let engine = instances.get(key)
  if (!engine) {
    engine = gateModelCalls(id === 'claude' ? new ClaudeEngine(profile) : new CodexEngine(profile))
    instances.set(key, engine)
  }
  return engine
}

export function installCloudEngines(): void {
  setCloudEngineFactory((id) => cloudEngine(id))
}
