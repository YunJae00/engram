import type { SdkUserMessage, SessionSdk } from './engine-claude-session.js'
import { textOf } from './engine-claude.js'
import { flog } from './flog.js'
import { spawnRuntime } from './process-client.js'

// A runtime kept open for short answers while a comet works, so saying
// something mid-work is answered in seconds instead of after a process
// start. One question at a time; each carries everything it needs, so the
// session's own memory is only a convenience and it is renewed often.

const TURNS_MAX = 24
const IDLE_MS = 10 * 60_000

export interface VoiceSpec { sdk: SessionSdk; binary: string; env?: NodeJS.ProcessEnv; workdir: string; model: string }

export class VoiceSession {
  private inbox: SdkUserMessage[] = []
  private wake: (() => void) | undefined
  private waiting: { resolve(text: string): void; reject(error: Error): void } | undefined
  private turns = 0
  private idle: NodeJS.Timeout | undefined
  private readonly abort = new AbortController()
  closed = false
  readonly key: string

  constructor(spec: VoiceSpec) {
    this.key = JSON.stringify([spec.binary, spec.model, spec.workdir])
    const stream = spec.sdk.query({
      prompt: this.questions(),
      options: {
        cwd: spec.workdir, env: spec.env, pathToClaudeCodeExecutable: spec.binary, spawnClaudeCodeProcess: spawnRuntime,
        abortController: this.abort, tools: [], strictMcpConfig: true, persistSession: false, settingSources: [], model: spec.model,
      },
    })
    void (async () => {
      let said = ''
      try {
        for await (const message of stream) {
          if (message.type === 'assistant') said += textOf((message as { message: { content: unknown } }).message.content)
          if (message.type !== 'result') continue
          const result = message as { is_error?: boolean; result?: string }
          const waiting = this.waiting
          this.waiting = undefined
          if (result.is_error) waiting?.reject(new Error(result.result || 'The voice could not answer.'))
          else waiting?.resolve(result.result || said)
          said = ''
        }
      } catch (error) {
        flog('voice', error instanceof Error ? error.message : String(error))
      } finally {
        this.close()
      }
    })()
    this.rest()
  }

  get ready(): boolean { return !this.closed && !this.waiting && this.turns < TURNS_MAX }

  ask(text: string, timeoutMs: number): Promise<string> {
    if (!this.ready) return Promise.reject(new Error('The voice is busy.'))
    this.turns++
    this.rest()
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.waiting) { this.waiting = undefined; reject(new Error('The voice took too long.')); this.close() } }, timeoutMs)
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
    this.idle = setTimeout(() => this.close(), IDLE_MS)
    this.idle.unref?.()
  }
}
