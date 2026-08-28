import { ENGINE_BUDGETS, type EngineDetection, type EngineEvent, type EngineJobInput } from 'core'
import { claudeBinary, cloudErrorKind, LOGIN_TIMEOUT_MS, runText, STATUS_TIMEOUT_MS, StatusCache, type CloudEngine } from './engine-cloud.js'
import { flog } from './flog.js'

// Claude, through the vendor's agent runtime bundled with this app. The
// runtime keeps the person's sign-in and does the billing; here every job is
// one turn, no tools, none of the person's own runtime settings loaded, and
// a schema when the caller needs the shape of the answer fixed.

interface AgentSdk {
  query(params: { prompt: string; options?: Record<string, unknown> }): AsyncIterable<SdkMessage>
}

type SdkMessage =
  | { type: 'assistant'; message: { content: unknown } }
  | { type: 'result'; subtype: string; is_error?: boolean; result?: string; errors?: string[]; structured_output?: unknown; api_error_status?: number | null }
  | { type: string }

export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('')
}

// The runtime's own answer to "is anyone signed in": JSON, one field of which
// is the verdict. Anything else is "could not tell", never "signed out".
export function readAuthStatus(out: string): EngineDetection {
  try {
    const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { loggedIn?: unknown }
    if (typeof parsed.loggedIn === 'boolean') return { installed: true, loggedIn: parsed.loggedIn, conclusive: true }
  } catch {
    /* not the runtime's JSON */
  }
  return { installed: true, loggedIn: false, conclusive: false }
}

export class ClaudeEngine implements CloudEngine {
  readonly id = 'claude' as const
  readonly label = 'Claude'
  private readonly status = new StatusCache()

  detect(): Promise<EngineDetection> {
    return this.status.read(async () => {
      const binary = claudeBinary()
      if (!binary) return { installed: false, loggedIn: false, conclusive: true }
      const { code, out } = await runText(binary, ['auth', 'status', '--json'], STATUS_TIMEOUT_MS)
      if (code === null) return { installed: true, loggedIn: false, conclusive: false }
      return readAuthStatus(out)
    })
  }

  async login(): Promise<{ ok: boolean; message?: string }> {
    const binary = claudeBinary()
    if (!binary) return { ok: false, message: 'the Claude runtime is not part of this build' }
    const { code, out } = await runText(binary, ['auth', 'login', '--claudeai'], LOGIN_TIMEOUT_MS)
    this.status.forget()
    const status = await this.detect()
    if (status.loggedIn) return { ok: true }
    flog('engine-claude', `login did not complete (exit ${code ?? 'timeout'}): ${out.slice(-300)}`)
    return { ok: false, message: out.trim().split('\n').pop() ?? 'sign-in did not complete' }
  }

  async logout(): Promise<void> {
    const binary = claudeBinary()
    if (binary) await runText(binary, ['auth', 'logout'], STATUS_TIMEOUT_MS)
    this.status.forget()
  }

  async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
    const binary = claudeBinary()
    if (!binary) {
      yield { type: 'error', message: 'the Claude runtime is not part of this build', kind: 'crash' }
      return
    }
    const sdk = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as AgentSdk
    const abort = new AbortController()
    const budget = job.timeoutMs ?? ENGINE_BUDGETS.job
    const timer = setTimeout(() => abort.abort(), budget)
    const onAbort = (): void => abort.abort()
    job.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const stream = sdk.query({
        prompt: job.prompt,
        options: {
          cwd: job.workdir,
          pathToClaudeCodeExecutable: binary,
          abortController: abort,
          // One answer, from the words alone: no files, no commands, and none
          // of the person's own runtime configuration riding along.
          tools: [],
          // A fixed shape is delivered through one more exchange when the
          // first answer came as prose; one turn leaves no room for it.
          maxTurns: job.jsonSchema ? 3 : 1,
          persistSession: false,
          settingSources: [],
          ...(job.jsonSchema ? { outputFormat: { type: 'json_schema', schema: job.jsonSchema } } : {}),
          // A chore is a few small decisions in a row; the mid-size model makes
          // each one in seconds where the largest takes a minute, and the
          // person's own default is theirs to keep for their own sessions.
          model: job.modelHint === 'fast' ? 'haiku' : 'sonnet',
        },
      })
      for await (const message of stream) {
        if (message.type === 'assistant') {
          const text = textOf((message as { message: { content: unknown } }).message.content)
          if (text) yield { type: 'token', text }
          continue
        }
        if (message.type !== 'result') continue
        const result = message as Extract<SdkMessage, { type: 'result' }>
        if (result.is_error || result.subtype !== 'success') {
          const said = (result.errors?.length ? result.errors.join('; ') : result.result) || result.subtype
          const kind = result.api_error_status === 401 || result.api_error_status === 403 ? 'auth' : result.api_error_status === 429 ? 'quota' : cloudErrorKind(said)
          yield { type: 'error', message: said, kind }
          return
        }
        yield { type: 'result', text: result.structured_output !== undefined ? JSON.stringify(result.structured_output) : (result.result ?? '') }
        return
      }
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
