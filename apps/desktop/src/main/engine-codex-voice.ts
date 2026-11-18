import type { CodexRpc, CodexRpcFactory } from './codex-native.js'
import { flog } from './flog.js'

type Data = Record<string, unknown>
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const TURNS_MAX = 24
const IDLE_MS = 60 * 60_000

interface CodexVoiceSpec { rpc: CodexRpcFactory; env: NodeJS.ProcessEnv; config: string[]; cwd: string; model?: string }

export class CodexVoice {
  private readonly rpc: CodexRpc
  private readonly opened: Promise<void>
  private threadId = ''
  private turnId = ''
  private answer = ''
  private waiting: { resolve(text: string): void; reject(error: Error): void } | undefined
  private turns = 0
  private running = false
  private idle: NodeJS.Timeout | undefined
  closed = false
  readonly key: string

  constructor(spec: CodexVoiceSpec) {
    this.key = JSON.stringify([spec.cwd, spec.model ?? '', spec.config])
    const rpc = spec.rpc({ cwd: spec.cwd, env: spec.env, config: spec.config }, (method, params) => this.notify(method, params),
      async () => ({ decision: 'decline' }), (error) => { flog('voice', error.message); this.close() })
    this.rpc = rpc
    this.opened = (async () => {
      await rpc.initialize()
      const thread = await rpc.send('thread/start', {
        cwd: spec.cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
        developerInstructions: 'Answer from the words you are given. You have no tools and need none.', ...(spec.model ? { model: spec.model } : {}),
      })
      this.threadId = text(object(thread['thread'])['id'])
      if (!this.threadId) throw new Error('The ChatGPT runtime did not open a session.')
    })()
    this.opened.catch(() => this.close())
    this.rest()
  }

  get ready(): boolean { return !this.closed && !this.waiting && !this.running && this.turns < TURNS_MAX }
  get spent(): boolean { return this.turns >= TURNS_MAX && !this.waiting && !this.running }

  async ask(words: string, timeoutMs: number): Promise<string> {
    if (!this.ready) throw new Error('The voice is busy.')
    this.turns++
    this.rest()
    const reply = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.waiting) { this.waiting = undefined; reject(new Error('The voice took too long.')); this.close() } }, timeoutMs)
      this.waiting = { resolve: (answer) => { clearTimeout(timer); resolve(answer) }, reject: (error) => { clearTimeout(timer); reject(error) } }
    })
    void (async () => {
      try {
        await this.opened
        if (this.closed) return
        this.answer = ''
        this.turnId = ''
        this.running = true
        const started = await this.rpc.send('turn/start', { threadId: this.threadId, input: [{ type: 'text', text: words, text_elements: [] }], approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' }, effort: 'low' })
        this.turnId = text(object(started['turn'])['id'])
      } catch (error) {
        this.waiting?.reject(error instanceof Error ? error : new Error(String(error)))
        this.waiting = undefined
        this.close()
      }
    })()
    return reply
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.idle)
    this.waiting?.reject(new Error('The voice closed.'))
    this.waiting = undefined
    void this.rpc.shutdown().catch(() => undefined)
  }

  private notify(method: string, params: Data): void {
    if (params['threadId'] && params['threadId'] !== this.threadId) return
    const eventTurn = text(params['turnId']) || text(object(params['turn'])['id'])
    if (this.turnId && eventTurn && eventTurn !== this.turnId) return
    if (method === 'turn/completed') this.running = false
    if (!this.waiting) return
    const item = object(params['item'])
    if (method === 'item/completed' && text(item['type']) === 'agentMessage') this.answer = text(item['text']) || this.answer
    if (method !== 'turn/completed') return
    const waiting = this.waiting
    this.waiting = undefined
    if (text(object(params['turn'])['status']) === 'completed') waiting.resolve(this.answer)
    else waiting.reject(new Error('The voice could not answer.'))
  }

  private rest(): void {
    clearTimeout(this.idle)
    this.idle = setTimeout(() => this.close(), IDLE_MS)
    this.idle.unref?.()
  }
}
