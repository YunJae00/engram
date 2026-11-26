import { HAND_OFF_TOOL, type QuickReply } from 'core'
import { textOf, type SdkUserMessage, type SessionSdk } from './engine-claude-session.js'
import { shapeOf } from './engine-claude-tools.js'
import { flog } from './flog.js'
import { spawnRuntime } from './process-client.js'

const IDLE_MS = 60 * 60_000
const SERVER = 'voice'

interface VoiceSpec { sdk: SessionSdk; binary: string; env?: NodeJS.ProcessEnv; workdir: string; model: string; idleMs?: number }

export class VoiceSession {
  private inbox: SdkUserMessage[] = []
  private wake: (() => void) | undefined
  private waiting: { resolve(reply: QuickReply): void; reject(error: Error): void } | undefined
  private said = ''
  private asked = false
  private late = 0
  private idle: NodeJS.Timeout | undefined
  private readonly abort = new AbortController()
  closed = false
  private readonly idleMs: number

  constructor(spec: VoiceSpec) {
    this.idleMs = spec.idleMs ?? IDLE_MS
    const server = spec.sdk.createSdkMcpServer({
      name: SERVER,
      alwaysLoad: true,
      tools: [spec.sdk.tool(HAND_OFF_TOOL.name, HAND_OFF_TOOL.description, shapeOf(HAND_OFF_TOOL.argsSchema), async (args) => {
        const waiting = this.waiting
        this.waiting = undefined
        waiting?.resolve({ text: this.said.trim(), handOff: String((args as { brief?: unknown }).brief ?? '') })
        queueMicrotask(() => this.close())
        return { content: [{ type: 'text', text: 'Handed off.' }] }
      })],
    })
    const stream = spec.sdk.query({
      prompt: this.questions(),
      options: {
        cwd: spec.workdir, env: spec.env, pathToClaudeCodeExecutable: spec.binary, spawnClaudeCodeProcess: spawnRuntime,
        abortController: this.abort, tools: [], permissionMode: 'dontAsk', mcpServers: { [SERVER]: server }, allowedTools: [`mcp__${SERVER}__${HAND_OFF_TOOL.name}`], strictMcpConfig: true, persistSession: false, settingSources: [], model: spec.model, effort: 'low',
        thinking: { type: 'disabled' },
      },
    })
    void (async () => {
      try {
        for await (const message of stream) {
          if (message.type === 'assistant') this.said += textOf((message as { message: { content: unknown } }).message.content)
          if (message.type !== 'result') continue
          const result = message as { is_error?: boolean; result?: string }
          if (this.late > 0) { this.late--; this.said = ''; continue }
          const waiting = this.waiting
          this.waiting = undefined
          if (result.is_error) waiting?.reject(new Error(result.result || 'The voice could not answer.'))
          else waiting?.resolve({ text: result.result || this.said })
          this.said = ''
        }
      } catch (error) {
        flog('voice', error instanceof Error ? error.message : String(error))
      } finally {
        this.close()
      }
    })()
    this.rest()
  }

  get ready(): boolean { return !this.closed && !this.waiting && this.late === 0 && !this.asked }
  get spent(): boolean { return this.asked && !this.waiting && this.late === 0 }

  ask(text: string, timeoutMs: number): Promise<QuickReply> {
    if (!this.ready) return Promise.reject(new Error('The voice is busy.'))
    this.asked = true
    this.rest()
    return new Promise<QuickReply>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.waiting) { this.waiting = undefined; this.late++; reject(new Error('The voice took too long.')) } }, timeoutMs)
      this.waiting = { resolve: (answer) => { clearTimeout(timer); resolve(answer) }, reject: (error) => { clearTimeout(timer); reject(error) } }
      this.inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' })
      this.wake?.()
    })
  }

  private async *questions(): AsyncIterable<SdkUserMessage> {
    while (!this.closed) {
      if (!this.inbox.length) await new Promise<void>((resolve) => { this.wake = resolve })
      const next = this.inbox.shift()
      if (next) yield next
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idle)
    this.waiting?.reject(new Error('The voice closed.'))
    this.waiting = undefined
    this.abort.abort()
    this.wake?.()
  }

  private rest(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), this.idleMs)
    this.idle.unref?.()
  }
}
