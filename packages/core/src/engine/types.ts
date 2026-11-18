import { classifyEngineError, type EngineErrorKind } from './classify.js'

export { classifyEngineError, type EngineErrorKind } from './classify.js'

export type EngineId = 'claude' | 'codex' | 'mock'
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export const REASONING_EFFORTS: readonly ReasoningEffort[] = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
export type PermissionMode = 'auto' | 'once' | 'each' | 'plan'
export const PERMISSION_MODES: readonly PermissionMode[] = ['auto', 'once', 'each', 'plan']
export const DESKTOP_TOOL_ISOLATION_MESSAGE = 'This connection cannot safely run selected-app tools yet. Use a connection with an isolated tool session, or turn off Computer access for this chat.'

export interface EngineDetection {
  installed: boolean
  loggedIn: boolean
  conclusive?: boolean
}

export type EngineCwd = string & { readonly __engineCwd: 'engineCwd' }

export class PrivatePathError extends Error {
  constructor(dir: string) {
    super(`engine cwd must never touch private/: ${dir}`)
    this.name = 'PrivatePathError'
  }
}

export function assertEngineCwd(dir: string): asserts dir is EngineCwd {
  const segments = dir.split(/[\\/]+/)
  if (segments.includes('private')) throw new PrivatePathError(dir)
}

export function engineCwd(paths: { workspace: string; privateDir: string }): EngineCwd {
  assertEngineCwd(paths.workspace)
  return paths.workspace
}

export const ENGINE_BUDGETS = {
  probe: 10_000,
  authStatus: 15_000,
  speech: 45_000,
  ping: 60_000,
  job: 300_000,
  chat: 300_000,
} as const

export interface EngineJobInput {
  model?: string
  effort?: ReasoningEffort
  prompt: string
  imagePaths?: string[]
  workdir: EngineCwd
  timeoutMs?: number
  idleTimeoutMs?: number
  signal?: AbortSignal
  disallowTools?: boolean
  requireToolIsolation?: boolean
  readOnly?: boolean
  modelHint?: 'fast' | 'smart'
  jsonSchema?: object
  maxTokens?: number
}

export type EngineEvent =
  | { type: 'token'; text: string }
  | { type: 'result'; text: string }
  | { type: 'error'; message: string; kind?: EngineErrorKind; retryAfterMs?: number }

export interface Engine {
  warm?(job: ToolSessionJob): Promise<void>
  spareReady?(): boolean
  warmQuick?(workdir: string): Promise<void>
  quick?(prompt: string, options: { workdir: string; timeoutMs: number }): Promise<string>
  claimWorkFolder?(channel: string, fallback: string): string
  readonly id: EngineId
  readonly desktopToolIsolation?: boolean
  readonly vision?: boolean
  detect(): Promise<EngineDetection>
  run(job: EngineJobInput): AsyncIterable<EngineEvent>
  runTools?(job: ToolSessionJob): Promise<ToolSessionResult>
}

export interface ToolSessionCall {
  name: string
  description: string
  argsSchema: object
  run(args: Record<string, unknown>): Promise<string | { text: string; image?: { data: string; mimeType: string } }>
}

export interface NativeDecision { behavior: 'allow' | 'deny'; message?: string; updatedInput?: Record<string, unknown> }

export interface NativeTools {
  cwd: string
  readRoots: string[]
  workspace?: string
  mode?: PermissionMode
  ready?(): boolean
  decide(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<NativeDecision>
  onCall?(name: string, input: Record<string, unknown>): void
  onResult?(name: string, ok: boolean): void
}

export interface ToolSessionJob {
  onUsage?(tokens: number): void
  onStart?(): void
  native?: NativeTools
  onContextReset?(): void
  model?: string
  modelHint?: 'fast' | 'smart'
  effort?: ReasoningEffort
  workdir: EngineCwd
  system: string
  prompt: string
  opening?: string
  sessionKey?: string
  tools: ToolSessionCall[]
  maxCalls: number
  signal?: AbortSignal
  onToken?(text: string): void
  onReset?(dropDraft?: boolean, tool?: string): void
  onProgress?(): void
  onSteerable?(steer: ((said: string[]) => Promise<boolean>) | null): void
}

export interface ToolSessionResult {
  answer: string
  error?: string
  note?: string
}

export class EngineCallError extends Error {
  constructor(
    message: string,
    readonly kind: EngineErrorKind,
  ) {
    super(message)
    this.name = 'EngineCallError'
  }
}

export class QuotaError extends EngineCallError {
  constructor(
    message = 'engine quota exhausted',
    readonly retryAfterMs?: number,
  ) {
    super(message, 'quota')
    this.name = 'QuotaError'
  }
}

export class AuthError extends EngineCallError {
  constructor(message = 'engine is not logged in') {
    super(message, 'auth')
    this.name = 'AuthError'
  }
}

export class OutageError extends EngineCallError {
  constructor(message = 'the AI provider is not answering') {
    super(message, 'outage')
    this.name = 'OutageError'
  }
}

export async function collectResult(engine: Engine, job: EngineJobInput): Promise<string> {
  assertEngineCwd(job.workdir)
  let tokens = ''
  let result: string | null = null
  for await (const event of engine.run(job)) {
    if (event.type === 'token') tokens += event.text
    else if (event.type === 'result') result = event.text
    else if (event.type === 'error') {
      const kind = event.kind ?? classifyEngineError(event.message)
      if (kind === 'quota') throw new QuotaError(event.message, event.retryAfterMs)
      if (kind === 'auth') throw new AuthError(`[${engine.id}] ${event.message}`)
      if (kind === 'outage') throw new OutageError(`[${engine.id}] ${event.message}`)
      throw new EngineCallError(`[${engine.id}] ${event.message}`, kind)
    }
  }
  const text = result ?? tokens
  if (text.trim().length === 0) throw new EngineCallError(`[${engine.id}] empty engine result`, 'crash')
  return text
}

export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, '')
  const start = cleaned.search(/[{[]/)
  if (start === -1) throw new Error('no JSON found in engine result')
  const open = cleaned[start]!
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]!
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1))
    }
  }
  throw new Error('unbalanced JSON in engine result')
}
