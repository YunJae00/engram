import { DESKTOP_TOOL_ISOLATION_MESSAGE, ENGINE_BUDGETS, type EngineDetection, type EngineEvent, type EngineJobInput } from 'core'
import { cloudErrorKind, codexBinary, LOGIN_TIMEOUT_MS, runText, STATUS_TIMEOUT_MS, StatusCache, withHelpersOnPath, type CloudEngine, type CloudLoginOptions } from './engine-cloud.js'
import { CodexAccount } from './codex-account.js'
import { loadSettings } from './settings.js'

// ChatGPT, through the vendor's agent runtime bundled with this app. The
// person signs in with their own plan in the vendor's flow; each job here is
// one read-only turn with web search disabled. This is not an isolated
// tool session: inherited runtime tools are a separate boundary.

interface CodexSdk {
  Codex: new (options: { codexPathOverride?: string; env?: Record<string, string> }) => {
    startThread(options: Record<string, unknown>): {
      run(input: string | ({ type: 'text'; text: string } | { type: 'local_image'; path: string })[], options: { outputSchema?: unknown; signal?: AbortSignal }): Promise<{ finalResponse: string }>
    }
  }
}

// Strict output requires every property; nullable fields represent omissions.
// Free-key maps remain closed because this output format cannot accept them.
export function strictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictSchema)
  if (schema === null || typeof schema !== 'object') return schema
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') continue
    out[key] = strictSchema(value)
  }
  if (out['type'] === 'object' || 'properties' in out) {
    const properties = (out['properties'] ?? {}) as Record<string, unknown>
    const required = new Set(Array.isArray(out['required']) ? out['required'] : [])
    out['properties'] = Object.fromEntries(Object.entries(properties).map(([key, value]) => [key,
      required.has(key) || allowsNull(value) ? value : { anyOf: [value, { type: 'null' }] },
    ]))
    out['required'] = Object.keys(properties)
    out['additionalProperties'] = false
  }
  return out
}

function allowsNull(schema: unknown): boolean {
  if (!schema || typeof schema !== 'object') return schema === true
  const node = schema as Record<string, unknown>
  return node['type'] === 'null' || (Array.isArray(node['type']) && node['type'].includes('null')) ||
    (Array.isArray(node['enum']) && node['enum'].includes(null)) || node['const'] === null ||
    (Array.isArray(node['anyOf']) && node['anyOf'].some(allowsNull))
}

// Undo only nulls introduced for optional properties, never explicit null data.
export function restoreOptionalFields(value: unknown, schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || value === null) return value
  const node = schema as Record<string, unknown>
  if (Array.isArray(value)) return value.map(item => restoreOptionalFields(item, node['items']))
  if (typeof value !== 'object') return value
  const properties = (node['properties'] ?? {}) as Record<string, unknown>
  const required = new Set(Array.isArray(node['required']) ? node['required'] : [])
  return Object.fromEntries(Object.entries(value).filter(([key, item]) =>
    item !== null || !(key in properties) || required.has(key) || allowsNull(properties[key]),
  ).map(([key, item]) => [key, restoreOptionalFields(item, properties[key])]))
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
  readonly desktopToolIsolation = false
  private readonly status = new StatusCache()

  detect(): Promise<EngineDetection> {
    return this.status.read(async () => {
      const binary = codexBinary()
      if (!binary) return { installed: false, loggedIn: false, conclusive: true }
      const { code, out } = await runText(binary, ['login', 'status'], STATUS_TIMEOUT_MS, withHelpersOnPath(binary))
      return readLoginStatus(out, code)
    })
  }

  async login(options?: CloudLoginOptions): Promise<{ ok: boolean; message?: string }> {
    const account = new CodexAccount(options?.signal ?? new AbortController().signal, LOGIN_TIMEOUT_MS)
    try {
      await account.login((url) => options?.onUrl?.(url))
      this.status.forget()
      return { ok: (await this.detect()).loggedIn }
    } finally { account.close() }
  }

  async logout(): Promise<void> {
    const binary = codexBinary()
    if (binary) await runText(binary, ['logout'], STATUS_TIMEOUT_MS, withHelpersOnPath(binary))
    this.status.forget()
  }

  async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
    if (job.requireToolIsolation) {
      yield { type: 'error', kind: 'crash', message: DESKTOP_TOOL_ISOLATION_MESSAGE }
      return
    }
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
      const input = job.imagePaths?.length ? [{ type: 'text' as const, text: job.prompt }, ...job.imagePaths.map(path => ({ type: 'local_image' as const, path }))] : job.prompt
      const turn = await thread.run(input, {
        ...(job.jsonSchema ? { outputSchema: strictSchema(job.jsonSchema) } : {}),
        signal: abort.signal,
      })
      let text = turn.finalResponse
      if (job.jsonSchema) {
        try { text = JSON.stringify(restoreOptionalFields(JSON.parse(text), job.jsonSchema)) } catch { /* Keep malformed output for the existing parser to diagnose. */ }
      }
      yield { type: 'result', text }
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
