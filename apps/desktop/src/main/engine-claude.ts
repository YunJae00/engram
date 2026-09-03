import { ENGINE_BUDGETS, type EngineDetection, type EngineEvent, type EngineJobInput, type ToolSessionJob, type ToolSessionResult } from 'core'
import { SessionPool, type SessionSdk } from './engine-claude-session.js'
import { claudeBinary, cloudErrorKind, LOGIN_TIMEOUT_MS, runText, STATUS_TIMEOUT_MS, StatusCache, type CloudEngine } from './engine-cloud.js'
import { flog } from './flog.js'
import { loadSettings } from './settings.js'

// The person's chosen model, read per call so a change in Settings or from
// the composer takes hold on the very next turn. Empty means the app's own
// spread: the mid-size model for the work, the small one for chores.
async function chosenModel(hint?: string): Promise<string> {
  const picked = (await loadSettings()).claudeModel.trim()
  if (picked) return picked
  return hint === 'fast' ? 'haiku' : 'sonnet'
}

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

// The models the person's plan offers, in the runtime's own words - the
// same list its own model menu shows, with the ids it takes. Asking means
// opening a session and closing it again, which costs a cold start, so the
// answer is kept for the life of the app and fetched once sign-in is known;
// a picker shows the aliases until then.
export interface ClaudeModelChoice {
  value: string
  label: string
  detail: string
}
let knownModels: ClaudeModelChoice[] = []
let fetchingModels: Promise<ClaudeModelChoice[]> | null = null
const MODELS_TIMEOUT_MS = 60_000

export function claudeModels(): ClaudeModelChoice[] {
  return knownModels
}

export function fetchClaudeModels(): Promise<ClaudeModelChoice[]> {
  if (knownModels.length > 0) return Promise.resolve(knownModels)
  if (fetchingModels) return fetchingModels
  const binary = claudeBinary()
  if (!binary) return Promise.resolve([])
  fetchingModels = (async () => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), MODELS_TIMEOUT_MS)
    try {
      const sdk = await sdkModule()
      // A session with nothing to say: the prompt never yields, the query
      // is only there to be asked what it could run.
      const silent = (async function* () {
        await new Promise<never>(() => {})
        yield undefined as never
      })()
      const handle = sdk.query({
        prompt: silent,
        options: { pathToClaudeCodeExecutable: binary, abortController: abort, tools: [], persistSession: false, settingSources: [], maxTurns: 1 },
      })
      const rows = await Promise.race([
        handle.supportedModels(),
        new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })),
      ])
      knownModels = rows.map((row) => ({ value: row.value, label: row.displayName, detail: row.description }))
      flog('engine-claude', `the plan offers ${knownModels.length} models: ${knownModels.map((m) => m.value).join(', ')}`)
      return knownModels
    } catch (err) {
      flog('engine-claude', `could not list models: ${err instanceof Error ? err.message : String(err)}`)
      return []
    } finally {
      clearTimeout(timer)
      abort.abort()
      fetchingModels = null
    }
  })()
  return fetchingModels
}

export function forgetClaudeModels(): void {
  knownModels = []
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
          // A chore is a few small decisions in a row; the mid-size model
          // makes each one in seconds where the largest takes a minute -
          // unless the person picked a model, and then their pick answers.
          model: await chosenModel(job.modelHint),
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

  // The whole turn in one session, and the session kept warm for the next:
  // the runtime is handed the comet's tools and loops over them itself.
  runTools(job: ToolSessionJob): Promise<ToolSessionResult> {
    const binary = claudeBinary()
    if (!binary) return Promise.resolve({ answer: '', error: 'the Claude runtime is not part of this build' })
    return Promise.all([sdkModule(), chosenModel()]).then(([sdk, model]) => sessions.run(job, { sdk, binary, workdir: job.workdir, model }))
  }
}

const sessions = new SessionPool()
setInterval(() => sessions.sweep(), 60_000).unref()

export function closeClaudeSessions(): void {
  sessions.closeAll()
}

async function sdkModule(): Promise<SessionSdk> {
  return (await import('@anthropic-ai/claude-agent-sdk')) as unknown as SessionSdk
}
