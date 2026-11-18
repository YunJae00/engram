import { type NativeTools, type ToolSessionCall, type ToolSessionJob, type ToolSessionResult } from 'core'
import { nativeOptions } from './engine-claude-native.js'
import { allowedToolNames, shapeOf, TOOL_SERVER } from './engine-claude-tools.js'
import { claudeSessionStarted } from './claude-runtime.js'
import { dirname } from 'node:path'
import { flog } from './flog.js'
import { spawnRuntime } from './process-client.js'
import { claudeTokenUsage } from './claude-token-usage.js'
import { currentLease, idleBeyond, inTurnSlot, type Lease } from './worker-pool.js'

export interface SdkUserMessage {
  type: 'user'
  message: { role: 'user'; content: string }
  parent_tool_use_id: null
  session_id: string
}

type SdkMessage =
  | { type: 'assistant'; message: { content: unknown } }
  | { type: 'result'; subtype: string; is_error?: boolean; result?: string; errors?: string[] }
  | { type: string }

export interface SessionSdk {
  query(params: { prompt: AsyncIterable<SdkUserMessage>; options?: Record<string, unknown> }): AsyncIterable<SdkMessage> & {
    interrupt(): Promise<unknown>
    supportedModels(): Promise<{ value: string; displayName: string; description: string; resolvedModel?: string; supportsEffort?: boolean; supportedEffortLevels?: import('core').ReasoningEffort[] }[]>
  }
  createSdkMcpServer(options: { name: string; tools: unknown[]; alwaysLoad?: boolean }): unknown
  tool(
    name: string,
    description: string,
    shape: Record<string, unknown>,
    handler: (args: unknown) => Promise<{ content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[] }>,
  ): unknown
}

interface SessionSpec {
  env?: NodeJS.ProcessEnv
  sdk: SessionSdk
  binary: string
  workdir: string
  model: string
}

const IDLE_MS = 60 * 60_000
export const STEP_IDLE_MS = 25_000
const RETRY_STEP = 'Your last request got no reply in time and was cut. Carry on from exactly where you were: the tool calls already made have their results above, so do not make them again.'
export const PRELOADED_TOOLS_MAX = 16

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('')
}

export function signatureOf(job: ToolSessionJob): string {
  return JSON.stringify([job.system, job.tools.map(({ name, description, argsSchema }) => ({ name, description, argsSchema })), job.effort, job.native && [job.native.cwd, job.native.mode, job.native.readRoots, 'sandbox' in job.native]])
}

interface Turn {
  startedAt: number; lease?: Lease
  lastToolEnd: number
  firstTool: boolean
  resolve(result: ToolSessionResult): void
  answer: string
  note?: string
  detachAbort(): void
  onToken?: (text: string) => void
  onProgress?: () => void
  onReset?: (dropDraft?: boolean, tool?: string) => void
  onContextReset?: () => void
  onUsage?: (tokens: number) => void
  calls: Set<string>
  idle?: ReturnType<typeof setTimeout>
  stalled?: boolean
  retried?: boolean
}

interface PartialEvent {
  type?: string
  delta?: { type?: string; text?: string; thinking?: unknown; partial_json?: unknown }
  content_block?: { type?: string; name?: string; id?: string }
}
const blocks = (content: unknown): { type?: string; id?: string; tool_use_id?: string }[] => Array.isArray(content) ? content.filter(block => block && typeof block === 'object') : []

class WarmSession {
  private resetNative: () => void = () => {}
  private readonly startedAt = performance.now()
  readonly signature: string
  private readonly runtime: string
  matches(spec: SessionSpec): boolean { return this.runtime === JSON.stringify([spec.binary, spec.model, spec.env]) }
  get model(): string {
    return this.spec.model
  }
  turns = 0
  lastUsed = Date.now()
  private readonly queue: SdkUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  private turn: Turn | null = null
  private tools = new Map<string, ToolSessionCall>()
  private native: NativeTools | undefined
  private query: { interrupt(): Promise<unknown> } | null = null
  private readonly abort = new AbortController()
  private readonly usage = claudeTokenUsage((raw, freshDelta) => {
    const message = raw as { type?: string; usage?: unknown; modelUsage?: unknown; message?: { usage?: unknown }; event?: { usage?: unknown; message?: { usage?: unknown } } }
    flog('token-usage', JSON.stringify({ engine: 'claude', freshDelta, usage: message.usage ?? message.message?.usage ?? message.event?.usage ?? message.event?.message?.usage, modelUsage: message.modelUsage }))
  })

  constructor(
    private readonly spec: SessionSpec,
    job: ToolSessionJob,
    private readonly onEnd: () => void,
  ) {
    this.signature = signatureOf(job)
    this.runtime = JSON.stringify([spec.binary, spec.model, spec.env])
    const server = spec.sdk.createSdkMcpServer({
      name: TOOL_SERVER,
      ...(job.tools.length <= PRELOADED_TOOLS_MAX ? { alwaysLoad: true } : {}),
      tools: job.tools.map((one) =>
        spec.sdk.tool(one.name, one.description, shapeOf(one.argsSchema), async (args) => {
          const tool = this.tools.get(one.name)
          if (this.turn && !this.turn.firstTool) {
            this.turn.firstTool = true
            flog('engine-turn-latency', `first_tool_ms=${Math.round(performance.now() - this.turn.startedAt)}`)
          }
          const turn = this.turn
          const started = performance.now()
          const gap = turn ? Math.round(started - turn.lastToolEnd) : 0
          const open = `host:${started}:${Math.random()}`
          turn?.calls.add(open); this.watch()
          const outcome = await (async () => {
            try { return tool ? await inTurnSlot(turn?.lease, () => tool.run(args as Record<string, unknown>)) : 'that tool is not available this turn' }
            finally {
              const ended = performance.now()
              turn?.calls.delete(open); this.watch()
              if (turn) turn.lastToolEnd = ended
              flog('engine-tool-latency', `tool=${one.name} between_tools_ms=${gap} tool_ms=${Math.round(ended - started)}`)
            }
          })()
          if (typeof outcome === 'string') return { content: [{ type: 'text', text: outcome }] }
          return {
            content: [
              { type: 'text', text: outcome.text },
              ...(outcome.image ? [{ type: 'image' as const, data: outcome.image.data, mimeType: outcome.image.mimeType }] : []),
            ],
          }
        }),
      ),
    })
    const { reset, ...native } = nativeOptions(() => this.native)
    this.resetNative = reset
    const stream = spec.sdk.query({
      prompt: this.input(),
      options: {
        cwd: job.native?.cwd ?? spec.workdir,
        env: spec.env,
        pathToClaudeCodeExecutable: spec.binary,
        spawnClaudeCodeProcess: spawnRuntime,
        abortController: this.abort,
        systemPrompt: job.system,
        ...(job.native ? { additionalDirectories: job.native.readRoots, ...native, ...('sandbox' in job.native ? { sandbox: job.native.sandbox } : {}) } : { tools: job.tools.length ? ['ToolSearch'] : [], permissionMode: 'dontAsk' }),
        mcpServers: { [TOOL_SERVER]: server },
        strictMcpConfig: true,
        allowedTools: allowedToolNames(job.tools),
        includePartialMessages: true,
        maxTurns: 400,
        persistSession: false,
        settingSources: [],
        model: spec.model,
        ...(job.effort ? { effort: job.effort } : {}),
      },
    })
    this.query = stream
    void this.pump(stream)
  }

  get busy(): boolean {
    return this.turn !== null
  }

  get stale(): boolean {
    return this.closed || Date.now() - this.lastUsed > IDLE_MS
  }

  private async *input(): AsyncGenerator<SdkUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private async pump(stream: AsyncIterable<SdkMessage>): Promise<void> {
    try {
      for await (const message of stream) {
        if (this.turn) {
          const tokens = this.usage(message)
          if (tokens) this.turn.onUsage?.(tokens)
          this.track(message)
        }
        if (message.type === 'system') {
          const system = message as { subtype?: string; estimated_tokens_delta?: unknown }
          if (system.subtype === 'compact_boundary') this.turn?.onContextReset?.()
          if (system.subtype === 'thinking_tokens' && typeof system.estimated_tokens_delta === 'number' && Number.isFinite(system.estimated_tokens_delta) && system.estimated_tokens_delta > 0) this.turn?.onProgress?.()
        }
        if (message.type === 'stream_event') {
          const event = (message as { event?: PartialEvent }).event
          if (event?.type === 'content_block_delta') {
            const delta = event.delta
            const progress = delta?.type === 'thinking_delta' ? delta.thinking : delta?.type === 'input_json_delta' ? delta.partial_json : undefined
            if (typeof progress === 'string' && progress.length > 0) this.turn?.onProgress?.()
          }
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta' && event.delta.text) this.turn?.onToken?.(event.delta.text)
          else if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') { this.turn?.onReset?.(undefined, event.content_block.name); this.noteBeforeCall() }
          continue
        }
        if (message.type === 'assistant') {
          const content = (message as { message: { content: unknown } }).message.content, text = textOf(content)
          if (text && this.turn) this.turn.answer = text
          if (Array.isArray(content) && content.some(block => (block as { type?: unknown })?.type === 'tool_use')) this.noteBeforeCall()
          continue
        }
        if (message.type === 'system' && (message as { subtype?: string }).subtype === 'init') {
          claudeSessionStarted()
          flog('engine-claude', `session running on ${(message as { model?: string }).model ?? 'an unnamed model'}; startup_ms=${Math.round(performance.now() - this.startedAt)}`)
          continue
        }
        if (message.type !== 'result') continue
        if (this.turn?.stalled && (message as { subtype?: string }).subtype !== 'success') {
          this.turn.stalled = false
          this.turn.retried = true
          this.queue.push({ type: 'user', message: { role: 'user', content: RETRY_STEP }, parent_tool_use_id: null, session_id: '' })
          this.wake?.()
          this.wake = null
          this.watch()
          continue
        }
        const result = message as Extract<SdkMessage, { type: 'result' }>
        const spoken = this.turn?.answer ?? ''
        if (result.is_error || (result.subtype !== 'success' && !spoken)) {
          const said = (result.errors?.length ? result.errors.join('; ') : result.result) || result.subtype
          this.finish({ answer: spoken, error: said })
          continue
        }
        const last = result.result?.trim() ?? '', note = this.turn?.note
        this.finish({ answer: (last !== note ? last : '') || spoken, ...(note && !spoken && (!last || last === note) ? { note } : {}) })
      }
    } catch (err) {
      this.finish({ answer: this.turn?.answer ?? '', error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.closed = true
      this.finish({ answer: this.turn?.answer ?? '', error: 'the session ended' })
      this.onEnd()
    }
  }

  private track(message: SdkMessage): void {
    const turn = this.turn!
    const event = message.type === 'stream_event' ? (message as { event?: PartialEvent }).event : undefined
    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') turn.calls.add(event.content_block.id ?? event.content_block.name ?? '')
    if (message.type === 'assistant') for (const block of blocks((message as { message: { content: unknown } }).message.content)) if (block.type === 'tool_use' && block.id) turn.calls.add(block.id)
    if (message.type === 'user') for (const block of blocks((message as { message?: { content?: unknown } }).message?.content)) if (block.type === 'tool_result' && block.tool_use_id) turn.calls.delete(block.tool_use_id)
    this.watch()
  }
  private watch(): void {
    const turn = this.turn
    if (!turn) return
    clearTimeout(turn.idle)
    turn.idle = turn.calls.size || turn.retried || turn.stalled ? undefined : setTimeout(() => {
      if (this.turn !== turn || turn.calls.size) return
      turn.stalled = true
      flog('engine-stall', JSON.stringify({ idle_ms: STEP_IDLE_MS, turn_ms: Math.round(performance.now() - turn.startedAt) }))
      void this.query?.interrupt().catch(() => undefined)
    }, STEP_IDLE_MS)
  }

  private noteBeforeCall(): void { if (this.turn?.answer) { this.turn.note = this.turn.answer; this.turn.answer = '' } }
  private finish(result: ToolSessionResult): void {
    const turn = this.turn
    if (!turn) return
    this.turn = null
    clearTimeout(turn.idle)
    this.native = undefined
    this.resetNative()
    turn.detachAbort()
    turn.resolve(result)
  }

  run(job: ToolSessionJob): Promise<ToolSessionResult> {
    if (job.signal?.aborted) return Promise.resolve({ answer: '', error: 'canceled' })
    if (this.closed) return Promise.resolve({ answer: '', error: 'the session ended' })
    this.tools = new Map(job.tools.map((tool) => [tool.name, tool]))
    const lease = currentLease(), own = job.native; this.native = own ? { ...own, decide: (name, input, signal) => inTurnSlot(lease, () => own.decide(name, input, signal)) } : undefined
    this.turns++
    this.lastUsed = Date.now()
    const content = this.turns === 1 && job.opening ? `${job.opening}\n\n${job.prompt}` : job.prompt
    return new Promise<ToolSessionResult>((resolve) => {
      const cut = (error: string): void => {
        if (this.turn !== turn) return
        void this.query?.interrupt().catch(() => undefined)
        this.finish({ answer: turn.answer, error })
        this.close()
      }
      const onAbort = (): void => cut('canceled')
      const now = performance.now()
      const turn: Turn = { calls: new Set(), lease: currentLease(), resolve, answer: '', detachAbort: () => job.signal?.removeEventListener('abort', onAbort), startedAt: now, lastToolEnd: now, firstTool: false, ...(job.onToken ? { onToken: job.onToken } : {}), ...(job.onProgress ? { onProgress: job.onProgress } : {}), ...(job.onReset ? { onReset: job.onReset } : {}), ...(job.onContextReset ? { onContextReset: job.onContextReset } : {}) }
      this.turn = turn
      turn.onUsage = job.onUsage
      job.signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })
      this.wake?.()
      this.wake = null
      this.watch()
    })
  }

  close(): void {
    this.closed = true
    this.wake?.()
    this.wake = null
    this.abort.abort()
    this.finish({ answer: '', error: 'the session was closed' })
  }
}

export class SessionPool {
  private readonly sessions = new Map<string, WarmSession>()
  private spare: { session: WarmSession; cwd: string; owner?: string } | null = null
  private readonly claimed = new Map<string, string>()

  claimWorkFolder(channel: string, fallback: string): string {
    const key = `${dirname(fallback)}:${channel}`
    const held = this.claimed.get(key)
    if (held) return held
    if (!this.spare || dirname(this.spare.cwd) !== dirname(fallback) || this.spare.owner && this.spare.owner !== channel || this.spare.session.stale || this.spare.session.busy) return fallback
    this.spare.owner = channel
    this.claimed.set(key, this.spare.cwd)
    return this.spare.cwd
  }

  warm(spec: SessionSpec, job: ToolSessionJob): void {
    if (this.spare && (this.spare.session.stale || !this.spare.session.matches(spec))) { this.spare.session.close(); this.spare = null }
    if (this.spare || !job.native) return
    const session = new WarmSession(spec, job, () => { if (this.spare?.session === session) this.spare = null })
    this.spare = { session, cwd: job.native.cwd }
    flog('engine-claude', `warming a spare session in ${job.native.cwd}`)
  }

  get spareReady(): boolean {
    return !!this.spare && !this.spare.session.stale && !this.spare.session.busy
  }

  run(job: ToolSessionJob, spec: SessionSpec): Promise<ToolSessionResult> {
    if (job.signal?.aborted) return Promise.resolve({ answer: '', error: 'canceled' })
    const key = job.sessionKey ?? 'default'
    let session = this.sessions.get(key)
    if (session && !session.matches(spec)) {
      session.close()
      session = undefined
    }
    if (session && (session.stale || session.busy || session.signature !== signatureOf(job))) {
      session.close()
      session = undefined
    }
    if (this.spare && job.native?.cwd === this.spare.cwd && (!this.spare.session.matches(spec) || this.spare.session.signature !== signatureOf(job))) { this.spare.session.close(); this.spare = null }
    if (!session && this.spare && job.native?.cwd === this.spare.cwd && this.spare.session.signature === signatureOf(job) && this.spare.session.matches(spec) && !this.spare.session.busy && !this.spare.session.stale) {
      flog('engine-claude', `${key} takes the spare session`)
      session = this.spare.session
      this.spare = null
      this.sessions.set(key, session)
    }
    if (!session) {
      flog('engine-claude', `opening a session for ${key}`)
      const opened = new WarmSession(spec, job, () => {
        if (this.sessions.get(key) === opened) this.sessions.delete(key)
      })
      session = opened
      this.sessions.set(key, session)
    }
    return session.run(job)
  }

  closeOne(key: string): void {
    this.sessions.get(key)?.close()
    this.sessions.delete(key)
  }

  trim(cap: number): void { for (const key of idleBeyond([...[...this.sessions].map(([key, s]) => ({ key, busy: s.busy, lastUsed: s.lastUsed })), ...(this.spare ? [{ key: '', busy: this.spare.session.busy, lastUsed: this.spare.session.lastUsed }] : [])], cap)) if (key) this.closeOne(key); else { this.spare?.session.close(); this.spare = null } }
  closeMatching(key: string): void {
    for (const stored of this.sessions.keys()) if (stored === key || stored.endsWith(`:${key}`)) this.closeOne(stored)
  }

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
    this.spare?.session.close()
    this.spare = null
    this.claimed.clear()
  }

  sweep(): void {
    if (this.spare?.session.stale) { this.spare.session.close(); this.spare = null }
    for (const [key, session] of this.sessions) {
      if (session.stale && !session.busy) {
        session.close()
        this.sessions.delete(key)
      }
    }
  }
}
