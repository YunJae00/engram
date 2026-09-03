import { ENGINE_BUDGETS, type EngineDetection, type EngineEvent, type EngineJobInput } from 'core'
import { cloudErrorKind, codexBinary, LOGIN_TIMEOUT_MS, runText, STATUS_TIMEOUT_MS, StatusCache, withHelpersOnPath, type CloudEngine } from './engine-cloud.js'
import { flog } from './flog.js'
import { loadSettings } from './settings.js'

// ChatGPT, through the vendor's agent runtime bundled with this app. The
// person signs in with their own plan in the vendor's flow; each job here is
// one read-only turn with no network, no commands, and the answer's shape
// fixed by a schema when the caller asks for one.

interface CodexSdk {
  Codex: new (options: { codexPathOverride?: string; env?: Record<string, string> }) => {
    startThread(options: Record<string, unknown>): {
      run(input: string, options: { outputSchema?: unknown; signal?: AbortSignal }): Promise<{ finalResponse: string }>
    }
  }
}

// This runtime reads schemas strictly: every object must close itself with
// additionalProperties: false, and a schema-valued additionalProperties (a
// map of free keys) is refused outright. The schemas are authored once for
// every brain, so the strictness is applied here, where the requirement
// lives - each object is closed, and a map collapses to a closed object the
// model simply will not fill. Losing a free-key argument beats losing the
// whole call to a 400.
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema)
  if (schema === null || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue
    out[key] = strictSchema(value)
  }
  if ((out['type'] === 'object' || 'properties' in out) && !('additionalProperties' in out)) out['additionalProperties'] = false
  return out
}

// "Not logged in" is the runtime's own wording; a status it printed anything
// else for is a sign-in.
export function readLoginStatus(out: string, code: number | null): EngineDetection {
  if (code === null) return { installed: true, loggedIn: false, conclusive: false }
  if (/not logged in/i.test(out)) return { installed: true, loggedIn: false, conclusive: true }
  if (/logged in/i.test(out)) return { installed: true, loggedIn: true, conclusive: true }
  return { installed: true, loggedIn: false, conclusive: false }
}

export class CodexEngine implements CloudEngine {
  readonly id = 'codex' as const
  readonly label = 'ChatGPT'
  private readonly status = new StatusCache()

  detect(): Promise<EngineDetection> {
    return this.status.read(async () => {
      const binary = codexBinary()
      if (!binary) return { installed: false, loggedIn: false, conclusive: true }
      const { code, out } = await runText(binary, ['login', 'status'], STATUS_TIMEOUT_MS, withHelpersOnPath(binary))
      return readLoginStatus(out, code)
    })
  }

  async login(): Promise<{ ok: boolean; message?: string }> {
    const binary = codexBinary()
    if (!binary) return { ok: false, message: 'the ChatGPT runtime is not part of this build' }
    const { code, out } = await runText(binary, ['login'], LOGIN_TIMEOUT_MS, withHelpersOnPath(binary))
    this.status.forget()
    const status = await this.detect()
    if (status.loggedIn) return { ok: true }
    flog('engine-codex', `login did not complete (exit ${code ?? 'timeout'}): ${out.slice(-300)}`)
    return { ok: false, message: out.trim().split('\n').pop() ?? 'sign-in did not complete' }
  }

  async logout(): Promise<void> {
    const binary = codexBinary()
    if (binary) await runText(binary, ['logout'], STATUS_TIMEOUT_MS, withHelpersOnPath(binary))
    this.status.forget()
  }

  async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
    const binary = codexBinary()
    if (!binary) {
      yield { type: 'error', message: 'the ChatGPT runtime is not part of this build', kind: 'crash' }
      return
    }
    const sdk = (await import('@openai/codex-sdk')) as unknown as CodexSdk
    const codexModel = (await loadSettings()).codexModel.trim()
    const abort = new AbortController()
    const budget = job.timeoutMs ?? ENGINE_BUDGETS.job
    const timer = setTimeout(() => abort.abort(), budget)
    const onAbort = (): void => abort.abort()
    job.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const codex = new sdk.Codex({ codexPathOverride: binary, env: withHelpersOnPath(binary) })
      const thread = codex.startThread({
        workingDirectory: job.workdir,
        sandboxMode: 'read-only',
        skipGitRepoCheck: true,
        approvalPolicy: 'never',
        webSearchMode: 'disabled',
        networkAccessEnabled: false,
        ...(job.modelHint === 'fast' ? { modelReasoningEffort: 'low' } : {}),
        // The person's chosen model, if they named one; the runtime's own
        // default - their plan's - otherwise.
        ...(codexModel ? { model: codexModel } : {}),
      })
      const turn = await thread.run(job.prompt, {
        ...(job.jsonSchema ? { outputSchema: strictSchema(job.jsonSchema) } : {}),
        signal: abort.signal,
      })
      yield { type: 'result', text: turn.finalResponse }
    } catch (err) {
      if (job.signal?.aborted) return
      if (abort.signal.aborted) {
        yield { type: 'error', message: `timed out after ${budget}ms`, kind: 'timeout' }
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      yield { type: 'error', message, kind: cloudErrorKind(message) }
    } finally {
      clearTimeout(timer)
      job.signal?.removeEventListener('abort', onAbort)
    }
  }
}
