import type { ToolSessionCall, ToolSessionJob, ToolSessionResult } from 'core'
import { allowedToolNames, shapeOf, TOOL_SERVER } from './engine-claude-tools.js'
import { flog } from './flog.js'

// The runtime takes a long breath before its first word - measured at
// fifteen to twenty seconds on a locked-down machine, most of it the
// process coming up. A comet that paid that on every turn felt slow no
// matter what the model did. So a comet's session stays open between turns:
// the next message goes into the same process, and only the tool calls and
// the answer cost anything. A session is recycled when it has been idle a
// while, after a dozen turns, or when what it was told at the start changed.

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
  }
  createSdkMcpServer(options: { name: string; tools: unknown[] }): unknown
  tool(
    name: string,
    description: string,
    shape: Record<string, unknown>,
    handler: (args: unknown) => Promise<{ content: { type: 'text'; text: string }[] }>,
  ): unknown
}

export interface SessionSpec {
  sdk: SessionSdk
  binary: string
  workdir: string
  model: string
}

const IDLE_MS = 10 * 60_000
const TURNS_MAX = 12
const TURN_BUDGET_MS = 240_000

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block && typeof block === 'object' && (block as { type?: string }).type === 'text' ? String((block as { text?: unknown }).text ?? '') : ''))
    .join('')
}

export function signatureOf(job: ToolSessionJob): string {
  return `${job.system}\n${job.tools.map((tool) => tool.name).join(',')}`
}

interface Turn {
  resolve(result: ToolSessionResult): void
  answer: string
  timer: ReturnType<typeof setTimeout>
}

export class WarmSession {
  readonly signature: string
  turns = 0
  lastUsed = Date.now()
  private readonly queue: SdkUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  private turn: Turn | null = null
  private tools = new Map<string, ToolSessionCall>()
  private query: { interrupt(): Promise<unknown> } | null = null
  private readonly abort = new AbortController()

  constructor(
    private readonly spec: SessionSpec,
    job: ToolSessionJob,
    private readonly onEnd: () => void,
  ) {
    this.signature = signatureOf(job)
    const server = spec.sdk.createSdkMcpServer({
      name: TOOL_SERVER,
      tools: job.tools.map((one) =>
        spec.sdk.tool(one.name, one.description, shapeOf(one.argsSchema), async (args) => {
          // The tool of the turn under way: the same name may run against a
          // different notebook or browser next time.
          const tool = this.tools.get(one.name)
          const text = tool ? await tool.run(args as Record<string, unknown>) : 'that tool is not available this turn'
          return { content: [{ type: 'text', text }] }
        }),
      ),
    })
    const stream = spec.sdk.query({
      prompt: this.input(),
      options: {
        cwd: spec.workdir,
        pathToClaudeCodeExecutable: spec.binary,
        abortController: this.abort,
        systemPrompt: job.system,
        tools: [],
        mcpServers: { [TOOL_SERVER]: server },
        allowedTools: allowedToolNames(job.tools),
        permissionMode: 'dontAsk',
        maxTurns: 400,
        persistSession: false,
        settingSources: [],
        model: spec.model,
      },
    })
    this.query = stream
    void this.pump(stream)
  }

  get busy(): boolean {
    return this.turn !== null
  }

  get stale(): boolean {
    return this.closed || this.turns >= TURNS_MAX || Date.now() - this.lastUsed > IDLE_MS
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
        if (message.type === 'assistant') {
          const text = textOf((message as { message: { content: unknown } }).message.content)
          if (text && this.turn) this.turn.answer = text
          continue
        }
        if (message.type !== 'result') continue
        const result = message as Extract<SdkMessage, { type: 'result' }>
        const spoken = this.turn?.answer ?? ''
        if (result.is_error || (result.subtype !== 'success' && !spoken)) {
          const said = (result.errors?.length ? result.errors.join('; ') : result.result) || result.subtype
          this.finish({ answer: spoken, error: said })
          continue
        }
        this.finish({ answer: result.result?.trim() || spoken })
      }
    } catch (err) {
      this.finish({ answer: this.turn?.answer ?? '', error: err instanceof Error ? err.message : String(err) })
    } finally {
      this.closed = true
      this.finish({ answer: this.turn?.answer ?? '', error: 'the session ended' })
      this.onEnd()
    }
  }

  private finish(result: ToolSessionResult): void {
    const turn = this.turn
    if (!turn) return
    this.turn = null
    clearTimeout(turn.timer)
    turn.resolve(result)
  }

  run(job: ToolSessionJob): Promise<ToolSessionResult> {
    if (this.closed) return Promise.resolve({ answer: '', error: 'the session ended' })
    this.tools = new Map(job.tools.map((tool) => [tool.name, tool]))
    this.turns++
    this.lastUsed = Date.now()
    // The conversation so far is given once, when the session opens; after
    // that the session remembers it.
    const content = this.turns === 1 && job.opening ? `${job.opening}\n\n${job.prompt}` : job.prompt
    return new Promise<ToolSessionResult>((resolve) => {
      // A turn cut short leaves a tool call in flight whose result would land
      // on the next turn; the session goes with it, and the next turn opens
      // a fresh one.
      const cut = (error: string): void => {
        void this.query?.interrupt().catch(() => undefined)
        this.finish({ answer: this.turn?.answer ?? '', error })
        this.close()
      }
      const timer = setTimeout(() => cut(`timed out after ${TURN_BUDGET_MS}ms`), TURN_BUDGET_MS)
      this.turn = { resolve, answer: '', timer }
      job.signal?.addEventListener('abort', () => cut('canceled'), { once: true })
      this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' })
      this.wake?.()
      this.wake = null
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

// One session per comet, keyed by the caller; a turn whose opening lines
// changed, or whose session went stale, gets a fresh one.
export class SessionPool {
  private readonly sessions = new Map<string, WarmSession>()

  run(job: ToolSessionJob, spec: SessionSpec): Promise<ToolSessionResult> {
    const key = job.sessionKey ?? 'default'
    let session = this.sessions.get(key)
    if (session && (session.stale || session.busy || session.signature !== signatureOf(job))) {
      session.close()
      session = undefined
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

  closeAll(): void {
    for (const session of this.sessions.values()) session.close()
    this.sessions.clear()
  }

  // Idle sessions are let go so a comet that fell silent does not keep a
  // process around for the rest of the day.
  sweep(): void {
    for (const [key, session] of this.sessions) {
      if (session.stale && !session.busy) {
        session.close()
        this.sessions.delete(key)
      }
    }
  }
}
