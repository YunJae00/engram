import { classifyEngineError, type EngineErrorKind } from './classify.js'

export { classifyEngineError, type EngineErrorKind } from './classify.js'

export type EngineId = 'claude' | 'local' | 'mock'

export interface EngineDetection {
  installed: boolean
  loggedIn: boolean
  // Set to false ONLY when the probe could not reach a verdict (it timed out,
  // as opposed to being refused). Absent means conclusive: an adapter that
  // cannot time out — the mock, a test stub — says nothing and is believed.
  //
  // Callers must not treat an inconclusive detection as "this engine is gone".
  // Detection re-runs every 10 minutes for the life of the process, so a single
  // slow probe on a busy or just-woken machine would otherwise retire a working
  // engine, which is what users experience as the connection dropping by itself.
  conclusive?: boolean
}

// Physical privacy barrier: the ONLY directory an engine may ever
// see is workspace/. The branded type forces call sites through engineCwd(),
// and adapters re-assert at spawn time.
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
  probe: 10_000, // claude --version
  authStatus: 15_000, // claude auth status
  speech: 45_000, // nudge speechwriter
  ping: 60_000, // boot ping
  job: 300_000, // librarian jobs
  chat: 300_000, // chat upper bound (signal cancels sooner)
} as const

export interface EngineJobInput {
  prompt: string
  workdir: EngineCwd
  // Total-duration budget. Unset = the adapter's default (job tier).
  timeoutMs?: number
  // Stdout-silence budget: a call that stops producing for this long is hung
  // and gets killed even inside its total budget. Unset = off.
  idleTimeoutMs?: number
  // Cancellation: abort → tree kill + silent end (no error event — a cancel
  // is the caller's decision, not a failure).
  signal?: AbortSignal
  // Data-in→JSON-out jobs (the librarian J1..J8) never need to read files or
  // run tools. When set, adapters bar their CLI from tool use so the model
  // answers only from the material embedded in the prompt (structural safety +
  // token savings). Adapters with no tool concept (mock) ignore it.
  disallowTools?: boolean
  // Read-only jobs (image transcription) may read workspace files but must
  // never write or execute. Ignored when disallowTools is set.
  readOnly?: boolean
  // Semantic speed hint, not a model name — core never learns model ids
  // (same philosophy as BinaryProvider). 'fast' asks the adapter for its
  // cheap tier and 'smart' for its mid judgment tier; each adapter resolves
  // the actual value from its own ENGRAM_{FAST,SMART}_MODEL_* env override
  // (with at most a vendor-alias fallback), and adapters without a configured
  // model for a tier ignore the hint and keep their default — so a hint can
  // never break an engine. Unset = the engine's own default model (chat).
  modelHint?: 'fast' | 'smart'
}

export type EngineEvent =
  | { type: 'token'; text: string }
  | { type: 'result'; text: string }
  // `kind` is the adapter's own reading of WHY, made where the stderr and the
  // exit code still exist. Optional so a hand-rolled engine (tests, mock) can
  // stay a two-field object; collectResult classifies the message when absent.
  | { type: 'error'; message: string; kind?: EngineErrorKind; retryAfterMs?: number }

export interface Engine {
  readonly id: EngineId
  // Multimodal CLI: can read an image file in the workspace and transcribe it.
  // Ingest prefers such an engine over local OCR (hybrid image pipeline).
  readonly vision?: boolean
  detect(): Promise<EngineDetection>
  // Authoritative, uncached "is this login usable right now?" — asked of the
  // CLI itself, not of a file on disk, because only the CLI knows whether the
  // token expired or was silently refreshed. THREE answers, and the third one
  // matters: `null` means the CLI could not be asked (old version without the
  // subcommand, spawn failure). Callers must treat null as "unknown" and leave
  // the last known state alone — "cannot ask" is never "logged out".
  // Optional: an adapter with no login concept (mock) simply omits it.
  verifyAuth?(): Promise<boolean | null>
  run(job: EngineJobInput): AsyncIterable<EngineEvent>
  // Optional warm chat lane (chat-session.ts): one long-lived process, many
  // turns — the per-question cold boot paid once. Adapters without it simply
  // omit it and chat rides run() as always; callers MUST keep that fallback.
  openChat?(opts: { workdir: EngineCwd; turnTimeoutMs?: number }): import('./chat-session.js').EngineChatSession
}

// Base for every classified engine failure, so a caller that only wants to
// branch on `kind` does not need to know the subclasses.
export class EngineCallError extends Error {
  constructor(
    message: string,
    readonly kind: EngineErrorKind,
  ) {
    super(message)
    this.name = 'EngineCallError'
  }
}

// Raised when a CLI reports a rate/usage limit (429). The sweep defers the
// remainder and substitutes the next installed engine.
export class QuotaError extends EngineCallError {
  // retryAfterMs: the CLI's own "resets at / retry after" when its message
  // carried one — the backoff gate uses it verbatim instead of guessing.
  constructor(
    message = 'engine quota exhausted',
    readonly retryAfterMs?: number,
  ) {
    super(message, 'quota')
    this.name = 'QuotaError'
  }
}

// Raised when the CLI's login is gone or unusable. Distinct from QuotaError
// because the remedy is different (log in vs. wait) and because retrying is
// pointless: an expired token does not become valid on the second attempt.
export class AuthError extends EngineCallError {
  constructor(message = 'engine is not logged in') {
    super(message, 'auth')
    this.name = 'AuthError'
  }
}

// Drains an engine run and returns the final text. Token events accumulate
// as a fallback for engines that never emit an explicit result.
export async function collectResult(engine: Engine, job: EngineJobInput): Promise<string> {
  assertEngineCwd(job.workdir)
  let tokens = ''
  let result: string | null = null
  for await (const event of engine.run(job)) {
    if (event.type === 'token') tokens += event.text
    else if (event.type === 'result') result = event.text
    else if (event.type === 'error') {
      // Trust the adapter's reading when it made one; fall back to reading the
      // message for engines that emit a bare error event.
      const kind = event.kind ?? classifyEngineError(event.message)
      if (kind === 'quota') throw new QuotaError(event.message, event.retryAfterMs)
      if (kind === 'auth') throw new AuthError(`[${engine.id}] ${event.message}`)
      throw new EngineCallError(`[${engine.id}] ${event.message}`, kind)
    }
  }
  const text = result ?? tokens
  // A CLI that printed a login prompt and exited 0 lands here. It is not an
  // auth verdict on its own (a model can legitimately answer nothing), so it
  // stays a crash — the health check asks the CLI directly for the auth truth.
  if (text.trim().length === 0) throw new EngineCallError(`[${engine.id}] empty engine result`, 'crash')
  return text
}

// Engines answer with prose around JSON more often than not — cut the first
// balanced JSON value out of the text.
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
