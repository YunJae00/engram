import { gateModelCalls } from './model-call-gate.js'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setCloudEngineFactory, traced, traceFolder, type Engine } from 'core'
import { ClaudeEngine, closeVoices, trimWarm, type ClaudeInputs } from './engine-claude.js'
import { SessionPool } from './engine-claude-session.js'
import { CodexEngine } from './engine-codex.js'
import { afterFirstClaudeSession, claudeSessionStarted, installedClaudeBinary, loadClaudeSdk } from './claude-runtime.js'
import { accountEnvironment, activeAccountProfile } from './account-profiles.js'
import { clearBrainConnection, hasBrainConnection, loadBrainConnections, probeConnection } from './brain-connections.js'
import { logSessionTools } from './session-diagnostics.js'
import { workerPool } from './worker-pool.js'
import type { CloudLoginOptions } from './run-text.js'

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

export function withHelpersOnPath(binary: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const helpers = join(dirname(dirname(binary)), 'codex-path')
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value
  const key = Object.keys(out).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  out[key] = out[key] ? `${helpers}${delimiter}${out[key]}` : helpers
  return out
}

export interface CloudEngine extends Engine {
  readonly id: CloudEngineId
  readonly label: string
  login(options?: CloudLoginOptions): Promise<{ ok: boolean; message?: string }>
  logout(): Promise<void>
  forgetStatus?(): void
  confirmAuth?(): void
}


const claudeSessions = new SessionPool()
setInterval(() => { claudeSessions.sweep(); trimWarm(claudeSessions) }, 60_000).unref()
workerPool.onTarget(() => trimWarm(claudeSessions))

export const claudeInputs: ClaudeInputs = {
  binary: claudeBinary,
  sdk: loadClaudeSdk,
  env: profile => accountEnvironment('claude', profile),
  loadConnections: loadBrainConnections,
  hasConnection: profile => hasBrainConnection('claude', profile),
  clearConnection: profile => clearBrainConnection('claude', profile),
  probeConnection: profile => probeConnection('claude', undefined, profile),
  logTools: job => logSessionTools('claude', job),
  started: claudeSessionStarted,
  afterFirstSession: afterFirstClaudeSession,
  sessions: claudeSessions,
}

export function claudeEngine(profile = activeAccountProfile('claude')): ClaudeEngine {
  return new ClaudeEngine(claudeInputs, profile)
}

export function closeClaudeSession(key: string): void {
  claudeSessions.closeMatching(key)
}

export function closeClaudeSessions(): void {
  claudeSessions.closeAll()
  closeVoices()
}

const instances = new Map<string, CloudEngine>()

export function cloudEngine(id: CloudEngineId, profile = activeAccountProfile(id)): CloudEngine {
  const key = `${id}:${profile}`
  let engine = instances.get(key)
  if (!engine) {
    const trace = process.env['ENGRAM_TRACE']?.trim()
    engine = traced(gateModelCalls(id === 'claude' ? claudeEngine(profile) : new CodexEngine(profile)), trace ? traceFolder(trace) : undefined)
    instances.set(key, engine)
  }
  return engine
}

export function installCloudEngines(): void {
  setCloudEngineFactory((id) => cloudEngine(id))
}
