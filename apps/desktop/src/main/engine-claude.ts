import { AsyncLocalStorage } from 'node:async_hooks'
import { currentModelCallContext, modelCall } from './model-call-metrics.js'
import { askInTurn } from './voice-line.js'
import { ENGINE_BUDGETS, type EngineDetection, type EngineEvent, type EngineJobInput, type ToolSessionJob, type ToolSessionResult } from 'core'
import { textOf, type SessionPool, type SessionSdk } from './engine-claude-session.js'
import type { CloudEngine } from './engine-cloud.js'
import { LOGIN_TIMEOUT_MS, runText, STATUS_TIMEOUT_MS, StatusCache, type CloudLoginOptions } from './run-text.js'
import { flog } from './flog.js'
import { withLease, workerPool } from './worker-pool.js'
import { claudeRetryAfterMs, cloudErrorKind } from './usage-limit.js'
import { CLAUDE_RUNTIME_VERSION, workModelFor } from './claude-runtime-version.js'
import { spawnRuntime } from './process-client.js'
import { VoiceSession } from './engine-claude-voice.js'

export function chosenModel(hint?: string, runtimeVersion = CLAUDE_RUNTIME_VERSION): string {
  const forced = process.env['ENGRAM_CLAUDE_MODEL']?.trim()
  if (forced) return forced
  return hint === 'fast' ? 'haiku' : hint === 'smart' ? 'sonnet' : workModelFor(runtimeVersion)
}

export const tierPurpose = new AsyncLocalStorage<string>()
function runPurpose(): string {
  const purpose = tierPurpose.getStore() ?? currentModelCallContext()?.purpose
  return !purpose || purpose === 'memory-maintenance' ? 'librarian' : purpose === 'comet-title' ? 'title' : purpose
}
const tier = (purpose: string, model: string, hint = 'work'): string => { flog('model-tier', JSON.stringify({ purpose, hint, model })); return model }

const UNSANDBOXED = 'Commands are not sandboxed: use only the files and network access needed for this request.'
const SANDBOXED = 'Commands run in a sandbox with no network and writes only inside the task folder. A command that needs more may ask to run outside the sandbox; the person approves each one.'
export const forSandbox = (job: ToolSessionJob): ToolSessionJob => job.native && 'sandbox' in job.native ? { ...job, system: job.system.replace(UNSANDBOXED, SANDBOXED) } : job

interface AgentSdk {
  query(params: { prompt: string; options?: Record<string, unknown> }): AsyncIterable<SdkMessage>
}

type SdkMessage =
  | { type: 'assistant'; message: { content: unknown } }
  | { type: 'result'; subtype: string; is_error?: boolean; result?: string; errors?: string[]; structured_output?: unknown; api_error_status?: number | null }
  | { type: string }

export interface ClaudeInputs {
  binary(): string | null
  sdk(): Promise<unknown>
  env(profile: string): NodeJS.ProcessEnv
  loadConnections(): Promise<unknown>
  hasConnection(profile: string): boolean
  clearConnection(profile: string): Promise<void>
  probeConnection(profile: string): Promise<{ ok: boolean; status: number }>
  logTools(job: ToolSessionJob): void
  started(): void
  afterFirstSession(): Promise<void>
  sessions: SessionPool
}

export function readAuthStatus(out: string): EngineDetection {
  try {
    const parsed = JSON.parse(out.slice(out.indexOf('{'))) as { loggedIn?: unknown }
    if (typeof parsed.loggedIn === 'boolean') return { installed: true, loggedIn: parsed.loggedIn, conclusive: true }
  } catch {
  }
  return { installed: true, loggedIn: false, conclusive: false }
}

interface ClaudeModelChoice {
  value: string
  label: string
  detail: string
  efforts?: import('core').ReasoningEffort[]
}
const MODELS_TIMEOUT_MS = 60_000

interface ClaudeState {
  catalogs: Map<string, { rows?: ClaudeModelChoice[]; pending?: Promise<ClaudeModelChoice[]> }>
  generation: number
  voices: (VoiceSession | undefined)[]
  voiceKeys: string[]
}
const states = new WeakMap<ClaudeInputs, ClaudeState>()
function stateOf(inputs: ClaudeInputs): ClaudeState {
  const state = states.get(inputs) ?? { catalogs: new Map(), generation: 0, voices: [], voiceKeys: [] }
  states.set(inputs, state)
  return state
}

export function fetchClaudeModels(inputs: ClaudeInputs, profile: string): Promise<ClaudeModelChoice[]> {
  const state = stateOf(inputs)
  const catalog = state.catalogs.get(profile) ?? {}
  state.catalogs.set(profile, catalog)
  if (catalog.rows?.length) return Promise.resolve(catalog.rows)
  if (catalog.pending) return catalog.pending
  const env = inputs.env(profile)
  const binary = inputs.binary()
  if (!binary) return Promise.resolve([])
  const generation = state.generation
  const pending = (async () => {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await inputs.afterFirstSession()
      timer = setTimeout(() => abort.abort(), MODELS_TIMEOUT_MS)
      const sdk = (await inputs.sdk()) as SessionSdk
      abort.signal.throwIfAborted()
      const silent = (async function* () {
        await new Promise<never>(() => {})
        yield undefined as never
      })()
      const handle = sdk.query({
        prompt: silent,
        options: { env, pathToClaudeCodeExecutable: binary, spawnClaudeCodeProcess: spawnRuntime, abortController: abort, tools: [], persistSession: false, settingSources: [], maxTurns: 1 },
      })
      const rows = await Promise.race([
        handle.supportedModels(),
        new Promise<never>((_, reject) => abort.signal.addEventListener('abort', () => reject(new Error('timed out')), { once: true })),
      ])
      if (generation !== state.generation) return []
      catalog.rows = rows.map((row) => ({ value: row.value, label: row.displayName, detail: row.description, efforts: row.supportsEffort === false ? [] : row.supportedEffortLevels ?? [] }))
      return catalog.rows
    } catch (err) {
      flog('engine-claude', `could not list models: ${err instanceof Error ? err.message : String(err)}`)
      return []
    } finally {
      clearTimeout(timer)
      abort.abort()
      if (state.generation === generation) catalog.pending = undefined
    }
  })()
  catalog.pending = pending
  return pending
}

export function forgetClaudeModels(inputs: ClaudeInputs): void {
  const state = stateOf(inputs)
  state.catalogs.clear()
  state.generation++
}

export class ClaudeEngine implements CloudEngine {
  private get env(): NodeJS.ProcessEnv { return this.inputs.env(this.accountProfile) }
  private readonly state: ClaudeState
  constructor(private readonly inputs: ClaudeInputs, readonly accountProfile: string) { this.state = stateOf(inputs) }
  readonly id = 'claude' as const
  readonly label = 'Claude'
  readonly desktopToolIsolation = true
  private readonly status = new StatusCache()
  forgetStatus(): void { this.status.forget() }

  async warmQuick(workdir: string): Promise<void> { await Promise.all(Array.from({ length: WARM_LANES }, (_, lane) => this.voiceFor(workdir, lane))) }
  async quick(prompt: string, options: { workdir: string; timeoutMs: number }): Promise<string> {
    const metric = modelCall('claude', prompt.length, 'low')
    tier('first-line', chosenModel('fast'), 'fast')
    let lane: number | undefined
    try { return await askInTurn(one => { lane = one; return this.voiceFor(options.workdir, one) }, prompt, options.timeoutMs, quickLanes()) }
    catch (error) {
      const voice = lane === undefined ? undefined : this.state.voices[lane]
      if (voice && !voice.closed && !voice.ready) { voice.close(); void this.voiceFor(options.workdir, lane).catch(() => undefined) }
      throw error
    }
    finally {
      metric.end()
      if (lane !== undefined && this.state.voices[lane]?.spent) void this.voiceFor(options.workdir, lane).catch(() => undefined)
    }
  }
  private async voiceFor(workdir: string, lane = 0): Promise<VoiceSession | undefined> {
    await this.inputs.loadConnections()
    const binary = this.inputs.binary()
    if (!binary) return undefined
    const spec = { sdk: await this.sdk(), binary, env: this.env, workdir, model: chosenModel('fast'), ...(lane >= WARM_LANES ? { idleMs: EXTRA_VOICE_IDLE_MS } : {}) }
    const key = JSON.stringify([spec.binary, spec.model, spec.workdir, this.accountProfile])
    const voice = this.state.voices[lane]
    if (!voice || voice.closed || voice.spent || this.state.voiceKeys[lane] !== key) { voice?.close(); this.state.voices[lane] = new VoiceSession(spec); this.state.voiceKeys[lane] = key }
    return this.state.voices[lane]
  }
  confirmAuth(): void { this.status.set({ installed: true, loggedIn: true, conclusive: true }) }

  detect(): Promise<EngineDetection> {
    return this.status.read(async () => {
      const binary = this.inputs.binary()
      if (!binary) return { installed: false, loggedIn: false, conclusive: true }
      await this.inputs.loadConnections()
      if (this.inputs.hasConnection(this.accountProfile)) { const probe = await this.inputs.probeConnection(this.accountProfile); return { installed: true, loggedIn: probe.ok, conclusive: probe.status !== 0 } }
      const { code, out } = await runText(binary, ['auth', 'status', '--json'], STATUS_TIMEOUT_MS, this.env as Record<string, string>)
      if (code === null) return { installed: true, loggedIn: false, conclusive: false }
      return readAuthStatus(out)
    })
  }

  async login(options?: CloudLoginOptions): Promise<{ ok: boolean; message?: string }> {
    const binary = this.inputs.binary()
    if (!binary) return { ok: false, message: 'Install the Claude runtime in Settings → AI before connecting.' }
    const { code } = await runText(binary, ['auth', 'login'], LOGIN_TIMEOUT_MS, this.env as Record<string, string>, options)
    options?.signal?.throwIfAborted()
    if (code === 0) this.status.set({ installed: true, loggedIn: true, conclusive: true })
    else this.status.forget()
    const status = await this.detect()
    if (status.loggedIn) {
      this.inputs.started()
      return { ok: true }
    }
    flog('engine-claude', `login did not complete (exit ${code ?? 'timeout'})`)
    return { ok: false, message: 'Claude sign-in did not complete. Try again and finish the browser steps.' }
  }

  async logout(): Promise<void> {
    await this.inputs.loadConnections()
    if (this.inputs.hasConnection(this.accountProfile)) { await this.inputs.clearConnection(this.accountProfile); this.status.forget(); return }
    const binary = this.inputs.binary()
    if (binary) await runText(binary, ['auth', 'logout'], STATUS_TIMEOUT_MS, this.env as Record<string, string>)
    this.status.forget()
  }

  async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
    await this.inputs.loadConnections()
    const binary = this.inputs.binary()
    if (!binary) {
      yield { type: 'error', message: 'Install the Claude runtime in Settings → AI before connecting.', kind: 'crash' }
      return
    }
    const sdk = (await this.inputs.sdk()) as AgentSdk
    const lease = await workerPool.lease(job.signal)
    if (!lease) return
    const abort = new AbortController()
    const budget = job.timeoutMs ?? ENGINE_BUDGETS.job
    const timer = setTimeout(() => abort.abort(), budget)
    const onAbort = (): void => abort.abort()
    job.signal?.addEventListener('abort', onAbort, { once: true })
    const metric = modelCall('claude', job.prompt.length, job.effort)
    try {
      const stream = sdk.query({
        prompt: job.prompt,
        options: {
          cwd: job.workdir,
          env: this.env,
          pathToClaudeCodeExecutable: binary,
          spawnClaudeCodeProcess: spawnRuntime,
          abortController: abort,
          tools: [],
          strictMcpConfig: true,
          maxTurns: job.jsonSchema ? 3 : 1,
          persistSession: false,
          settingSources: [],
          ...(job.jsonSchema ? { outputFormat: { type: 'json_schema', schema: job.jsonSchema } } : {}),
          model: tier(runPurpose(), chosenModel(job.modelHint), job.modelHint),
          ...(job.effort ? { effort: job.effort } : {}),
        },
      })
      for await (const message of stream) {
        if (message.type === 'assistant') {
          const text = textOf((message as { message: { content: unknown } }).message.content)
          if (text) { metric.token(); yield { type: 'token', text } }
          continue
        }
        if (message.type !== 'result') continue
        const result = message as Extract<SdkMessage, { type: 'result' }>
        if (result.is_error || result.subtype !== 'success') {
          const said = (result.errors?.length ? result.errors.join('; ') : result.result) || result.subtype
          const kind = result.api_error_status === 401 || result.api_error_status === 403 ? 'auth' : result.api_error_status === 429 ? 'quota' : cloudErrorKind(said)
          yield { type: 'error', message: said, kind, ...(kind === 'quota' ? { retryAfterMs: claudeRetryAfterMs(said) } : {}) }
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
      lease.end()
      trimWarm(this.inputs)
      metric.end()
      clearTimeout(timer)
      job.signal?.removeEventListener('abort', onAbort)
    }
  }

  async runTools(job: ToolSessionJob): Promise<ToolSessionResult> {
    const binary = this.inputs.binary()
    if (!binary) return Promise.resolve({ answer: '', error: 'Install the Claude runtime in Settings → AI before connecting.' })
    job = forSandbox(job)
    const lease = await workerPool.lease(job.signal)
    if (!lease) return { answer: '', error: 'canceled' }
    job.onStart?.()
    const metric = modelCall('claude', job.prompt.length + job.system.length, job.effort, job.tools.length)
    const onToken = job.onToken
    job = { ...job, onToken: text => { metric.token(); onToken?.(text) } }
    return Promise.all([this.sdk(), tier('work', chosenModel(job.modelHint), job.modelHint), this.inputs.loadConnections()]).then(([sdk, model]) => { this.inputs.logTools(job); return withLease(lease, () => this.inputs.sessions.run({ ...job, sessionKey: `${this.accountProfile}:${job.sessionKey ?? 'default'}` }, { sdk, binary, workdir: job.workdir, model, env: this.env, started: this.inputs.started })) }).finally(() => { lease.end(); trimWarm(this.inputs); metric.end() })
  }

  async warm(job: ToolSessionJob): Promise<void> {
    if (job.signal?.aborted) return
    const binary = this.inputs.binary()
    if (!binary || !job.native) return
    job = forSandbox(job)
    const [sdk, model] = await Promise.all([this.sdk(), chosenModel(), this.inputs.loadConnections()])
    if (job.signal?.aborted) return
    this.inputs.sessions.warm({ sdk, binary, workdir: job.workdir, model, env: this.env, started: this.inputs.started }, job)
  }
  spareReady(): boolean { return this.inputs.sessions.spareReady }
  claimWorkFolder(channel: string, fallback: string): string { return this.inputs.sessions.claimWorkFolder(channel, fallback) }
  private async sdk(): Promise<SessionSdk> { return (await this.inputs.sdk()) as SessionSdk }
}

export function trimWarm(inputs: ClaudeInputs): void { inputs.sessions.trim(workerPool.target + 1 - stateOf(inputs).voices.filter(voice => voice && !voice.closed).length) }

export function closeVoices(inputs: ClaudeInputs): void {
  for (const voice of stateOf(inputs).voices) voice?.close()
}
const QUICK_LANES = 3, WARM_LANES = 2, EXTRA_VOICE_IDLE_MS = 2 * 60_000
const quickLanes = (): number => Math.max(WARM_LANES, Math.min(QUICK_LANES, workerPool.target))
