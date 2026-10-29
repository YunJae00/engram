import type { NativeDecision, NativeTools, ToolSessionJob, ToolSessionResult } from 'core'
import { DevRpc } from './dev-rpc.js'
import { flog } from './flog.js'
import { dirname } from 'node:path'

// ChatGPT with its own shell and patch tools, through the runtime's app
// server. The process and its thread stay up between a comet's turns, as a
// person keeps a window open; a turn whose rules, folder or model changed
// opens a new one. Native commands stay sandboxed; Engram tools use the
// loopback tool server.

type Data = Record<string, unknown>
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
// The runtime wraps each command in its shell; the person reads the command itself.
const commandOf = (data: Data): string => (Array.isArray(data['commandActions']) ? data['commandActions'] : []).map(action => text(object(action)['command'])).filter(Boolean).join('; ') || text(data['command'])
const DECISION_MS = 120_000
const IDLE_MS = 60 * 60_000

export interface CodexRpc {
  initialize(): Promise<void>
  send(method: string, params: Data, timeout?: number): Promise<Data>
  shutdown(): Promise<void>
}
export type CodexRpcFactory = (
  options: { cwd: string; env: NodeJS.ProcessEnv; config: string[] },
  notify: (method: string, params: Data) => void,
  request: (method: string, params: Data) => Promise<unknown>,
  ended: (error: Error) => void,
) => CodexRpc

export const appServer = (binary: string): CodexRpcFactory => (options, notify, request, ended) =>
  new DevRpc(binary, { cwd: options.cwd, env: options.env, config: options.config }, notify, request, ended)

export interface CodexNativeSpec {
  rpc: CodexRpcFactory
  env: NodeJS.ProcessEnv
  config: string[]
  instructions: string
  model?: string
}

type Job = ToolSessionJob & { native: NativeTools }
type NativeResult = ToolSessionResult & { commandsDenied?: true }

interface Turn {
  job: Job
  answer: string
  turnId: string
  settled: boolean
  // Until command use is approved, the runtime asks before each command and
  // the first one asked for is put to the person. An approved command there
  // may be retried outside the sandbox without a second ask, so it is
  // declined, and the turn restarts where approval is never asked or widened.
  ready: boolean
  restart: boolean
  refused: boolean
  recorded: Set<string>
  changes: Map<string, string[]>
  controller: AbortController
  cancel(): void
  resolve(result: ToolSessionResult): void
}

class CodexSession {
  private readonly rpc: CodexRpc
  private threadId = ''
  private turn: Turn | null = null
  private closed = false
  private readonly completedTurns = new Set<string>()
  lastUsed = Date.now()

  constructor(private readonly spec: CodexNativeSpec, private readonly cwd: string, readonly signature: string, private readonly onEnd: () => void) {
    this.rpc = spec.rpc({ cwd, env: spec.env, config: spec.config }, (method, params) => this.notify(method, params), (method, params) => this.request(method, params), (error) => this.end(error))
  }

  get busy(): boolean { return this.turn !== null }
  get stale(): boolean { return this.closed || Date.now() - this.lastUsed > IDLE_MS }

  async open(ready: boolean): Promise<void> {
    await this.rpc.initialize()
    const thread = await this.rpc.send('thread/start', {
      cwd: this.cwd, approvalPolicy: ready ? 'never' : 'untrusted', approvalsReviewer: 'user', sandbox: 'workspace-write', ephemeral: true,
      developerInstructions: this.spec.instructions, ...(this.spec.model ? { model: this.spec.model } : {}),
    })
    this.threadId = text(object(thread['thread'])['id'])
    if (!this.threadId) throw new Error('The ChatGPT runtime did not open a session.')
  }

  // One turn; the conversation so far travels only with the first on this thread.
  run(job: Job, fresh: boolean): Promise<ToolSessionResult> {
    if (this.closed || job.signal?.aborted) return Promise.resolve({ answer: '', error: job.signal?.aborted ? 'canceled' : 'the session was closed' })
    return new Promise<ToolSessionResult>((resolve) => {
      const turn: Turn = {
        job, answer: '', turnId: '', settled: false, ready: job.native.ready?.() ?? false, restart: false, refused: false,
        recorded: new Set(), changes: new Map(), controller: new AbortController(), resolve,
        cancel: () => {
          if (this.threadId && turn.turnId) void this.rpc.send('turn/interrupt', { threadId: this.threadId, turnId: turn.turnId }, 5_000).catch(() => undefined)
          this.finish(turn, { answer: turn.answer, error: 'canceled' })
          this.close()
        },
      }
      this.turn = turn
      this.lastUsed = Date.now()
      if (job.signal?.aborted) { turn.cancel(); return }
      job.signal?.addEventListener('abort', turn.cancel, { once: true })
      this.startTurn(turn, [fresh ? job.opening : undefined, job.prompt].filter(Boolean).join('\n\n'))
        .catch((error: unknown) => { this.finish(turn, { answer: turn.answer, error: error instanceof Error ? error.message : String(error) }); this.close() })
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.onEnd()
    if (this.turn) this.finish(this.turn, { answer: this.turn.answer, error: 'canceled' })
    void this.rpc.shutdown().catch(() => undefined)
  }

  private end(error: Error): void {
    if (this.turn) this.finish(this.turn, { answer: this.turn.answer, error: error.message })
    this.close()
  }

  private finish(turn: Turn, result: ToolSessionResult): void {
    if (turn.settled) return
    turn.settled = true
    if (turn.turnId) this.completedTurns.add(turn.turnId)
    turn.controller.abort()
    turn.job.onSteerable?.(null)
    turn.job.signal?.removeEventListener('abort', turn.cancel)
    if (this.turn === turn) this.turn = null
    this.lastUsed = Date.now()
    turn.resolve(result)
  }

  private async startTurn(turn: Turn, words: string): Promise<void> {
    const started = await this.rpc.send('turn/start', {
      threadId: this.threadId, input: [{ type: 'text', text: words, text_elements: [] }], approvalPolicy: turn.ready ? 'never' : 'untrusted',
      sandboxPolicy: { type: 'workspaceWrite', writableRoots: [this.cwd], networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true },
      ...(turn.job.effort ? { effort: turn.job.effort } : {}),
    })
    turn.turnId = text(object(started['turn'])['id'])
    if (turn.turnId && !turn.settled) turn.job.onSteerable?.((said) => this.steer(turn, said))
  }

  // Words the person sent mid-turn join it as their own message.
  private async steer(turn: Turn, said: string[]): Promise<boolean> {
    if (turn.settled || this.turn !== turn || !turn.turnId) return false
    await this.rpc.send('turn/steer', { threadId: this.threadId, expectedTurnId: turn.turnId, input: said.map((words) => ({ type: 'text', text: words, text_elements: [] })) }, 5_000)
    return true
  }

  // One answer per call, bounded: a decision that does not come is a refusal.
  private async decide(turn: Turn, name: string, input: Data): Promise<NativeDecision> {
    const call = new AbortController()
    const stop = () => call.abort()
    turn.controller.signal.addEventListener('abort', stop, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const late = new Promise<NativeDecision>((done) => { timer = setTimeout(() => { call.abort(); done({ behavior: 'deny', message: 'No decision arrived in time.' }) }, DECISION_MS); timer.unref() })
      const result = await Promise.race([turn.job.native.decide(name, input, call.signal), late])
      if (call.signal.aborted && result.behavior === 'allow') return { behavior: 'deny', message: 'The call was canceled.' }
      if (result.behavior === 'deny') flog('native-tools', `denied ${name}: ${result.message ?? ''}`)
      return result
    } catch { return { behavior: 'deny', message: 'The permission check failed.' } }
    finally { clearTimeout(timer); turn.controller.signal.removeEventListener('abort', stop) }
  }

  private notify(method: string, params: Data): void {
    const turn = this.turn
    if (!turn || turn.settled || (params['threadId'] && params['threadId'] !== this.threadId)) return
    const eventTurn = text(params['turnId']) || text(object(params['turn'])['id'])
    if (eventTurn && (this.completedTurns.has(eventTurn) || turn.turnId && eventTurn !== turn.turnId)) return
    const { job, recorded } = turn
    job.onProgress?.()
    if (method === 'item/agentMessage/delta') { job.onToken?.(text(params['delta'])); return }
    const item = object(params['item']), id = text(item['id']), type = text(item['type'])
    const paths = (): string => (Array.isArray(item['changes']) ? item['changes'] : []).map(change => text(object(change)['path'])).join(', ')
    if (method === 'item/started') {
      // Words before an action were thinking aloud, not the reply.
      if (type && type !== 'agentMessage' && type !== 'userMessage' && type !== 'reasoning') job.onReset?.()
      if (type === 'fileChange') turn.changes.set(id, (Array.isArray(item['changes']) ? item['changes'] : []).map(change => text(object(change)['path'])))
      if (type === 'commandExecution' || type === 'fileChange') {
        recorded.add(id)
        job.native.onCall?.(type === 'commandExecution' ? 'Bash' : 'Write', type === 'commandExecution' ? { command: commandOf(item) } : { file_path: paths() })
      }
      return
    }
    if (method === 'item/completed') {
      if (type === 'agentMessage') turn.answer = text(item['text']) || turn.answer
      if (type === 'commandExecution' || type === 'fileChange') {
        const name = type === 'commandExecution' ? 'Bash' : 'Write'
        if (!recorded.has(id)) job.native.onCall?.(name, type === 'commandExecution' ? { command: commandOf(item) } : { file_path: paths() })
        recorded.delete(id)
        job.native.onResult?.(name, text(item['status']) === 'completed' && (type !== 'commandExecution' || item['exitCode'] === 0))
      }
      return
    }
    if (method === 'turn/completed') {
      const status = text(object(params['turn'])['status'])
      if (status === 'interrupted' && turn.restart) {
        if (turn.turnId) this.completedTurns.add(turn.turnId)
        turn.turnId = ''
        turn.restart = false
        turn.answer = ''
        job.onReset?.()
        void this.startTurn(turn, 'The person allowed commands for this comet. Continue the task, running the command you were about to run.')
          .catch((error: unknown) => { this.finish(turn, { answer: turn.answer, error: error instanceof Error ? error.message : String(error) }); this.close() })
        return
      }
      if (status === 'completed') { this.finish(turn, { answer: turn.answer }); return }
      this.finish(turn, { answer: turn.answer, error: status === 'interrupted' ? 'canceled' : text(object(object(params['turn'])['error'])['message']) || 'The ChatGPT turn failed.' })
      this.close()
      return
    }
    if (method === 'error' && !params['willRetry']) {
      this.finish(turn, { answer: turn.answer, error: text(object(params['error'])['message']) || 'The ChatGPT runtime reported an error.' })
      this.close()
    }
  }

  private async request(method: string, params: Data): Promise<unknown> {
    const turn = this.turn
    if (!turn || turn.settled || params['threadId'] !== this.threadId) throw new Error('This request does not belong to the active turn.')
    const requestedTurn = text(params['turnId'])
    if (requestedTurn && (this.completedTurns.has(requestedTurn) || turn.turnId && requestedTurn !== turn.turnId)) throw new Error('This request belongs to a previous turn.')
    // Requests to widen the sandbox are never granted.
    if (method === 'item/commandExecution/requestApproval') {
      const command = commandOf(params)
      if (turn.ready || turn.restart || turn.refused || params['kind'] !== 'command' || params['reason'] || params['networkApprovalContext'] || !command) return { decision: 'decline' }
      // One question per turn: a refusal or no answer holds for the rest of it.
      if ((await this.decide(turn, 'Bash', { command })).behavior !== 'allow' || turn.settled) { turn.refused = true; return { decision: 'decline' } }
      turn.ready = turn.restart = true
      void this.rpc.send('turn/interrupt', { threadId: this.threadId, turnId: turn.turnId }, 5_000).catch(() => undefined)
      return { decision: 'decline' }
    }
    // A patch inside the task folder is never denied by the sandbox, so accepting it widens nothing.
    if (method === 'item/fileChange/requestApproval') {
      const paths = turn.changes.get(text(params['itemId']))
      if (params['grantRoot'] || !paths?.length) return { decision: 'decline' }
      for (const path of paths) if ((await this.decide(turn, 'Write', { file_path: path })).behavior !== 'allow') return { decision: 'decline' }
      return { decision: 'accept' }
    }
    if (method === 'item/tool/requestUserInput') throw new Error('Ask with ask_person instead.')
    throw new Error('This permission request is not supported; nothing was granted.')
  }
}

// One session per comet, kept between turns; a job without a session key gets its own, closed after the turn.
const sessions = new Map<string, CodexSession>()
// A session opened ahead in a folder of its own: the comet that takes the folder takes the session.
let spare: { session: CodexSession; cwd: string; opening: Promise<boolean>; owner?: string } | null = null
const claimed = new Map<string, string>()
const sweep = (): void => {
  if (spare?.session.stale) { spare.session.close(); spare = null }
  for (const [key, session] of sessions) if (session.stale && !session.busy) { session.close(); sessions.delete(key) }
}
const signatureOf = (native: NativeTools, spec: CodexNativeSpec): string => JSON.stringify([native.cwd, native.mode, native.readRoots, spec.config, spec.instructions, spec.model, spec.env])

export function claimCodexWorkFolder(channel: string, fallback: string): string {
  const key = `${dirname(fallback)}:${channel}`
  const held = claimed.get(key)
  if (held) return held
  if (!spare || dirname(spare.cwd) !== dirname(fallback) || spare.owner && spare.owner !== channel || spare.session.stale || spare.session.busy) return fallback
  spare.owner = channel
  claimed.set(key, spare.cwd)
  return spare.cwd
}
export const codexSpareReady = (): boolean => !!spare && !spare.session.stale && !spare.session.busy

export async function warmCodexSession(spec: CodexNativeSpec, native: NativeTools): Promise<void> {
  sweep()
  if (codexSpareReady()) return
  const session = new CodexSession(spec, native.cwd, signatureOf(native, spec), () => { if (spare?.session === session) spare = null })
  let failure: unknown
  const opening = session.open(false).then(() => true, (error: unknown) => { failure = error; session.close(); return false })
  spare = { session, cwd: native.cwd, opening }
  flog('engine-codex', `warming a spare session in ${native.cwd}`)
  if (!(await opening)) throw failure
}

export function closeCodexSession(key: string): void {
  for (const [stored, session] of sessions) if (stored === key || stored.endsWith(`:${key}`)) { session.close(); sessions.delete(stored) }
}

export function closeCodexSessions(): void {
  for (const session of sessions.values()) session.close()
  sessions.clear()
  spare?.session.close()
  spare = null
  claimed.clear()
}

export async function runCodexNative(job: Job, spec: CodexNativeSpec): Promise<NativeResult> {
  if (job.signal?.aborted) return { answer: '', error: 'canceled' }
  const native = job.native, key = job.sessionKey
  if (native.mode === 'each') return { answer: '', error: 'ChatGPT uses Engram tools in Ask every time mode; native commands are disabled.', commandsDenied: true }
  const signature = signatureOf(native, spec)
  sweep()
  let session = key ? sessions.get(key) : undefined
  if (session && (session.stale || session.busy || session.signature !== signature)) { session.close(); session = undefined }
  const fresh = !session
  let opened = !!session
  let opening: Promise<boolean> | undefined
  if (spare?.cwd === native.cwd && spare.session.signature !== signature) { spare.session.close(); spare = null }
  if (!session && key && spare && spare.cwd === native.cwd && spare.session.signature === signature && !spare.session.busy && !spare.session.stale) {
    const taken = spare
    spare = null
    session = taken.session
    sessions.set(key, session)
    opening = taken.opening
    opened = true
  }
  if (!session) {
    const opened = new CodexSession(spec, native.cwd, signature, () => { if (key && sessions.get(key) === opened) sessions.delete(key) })
    session = opened
    if (key) sessions.set(key, opened)
    flog('engine-codex', `opening a session for ${key ?? 'one turn'}`)
  }
  const current = session
  if (job.signal?.aborted) { current.close(); return { answer: '', error: 'canceled' } }
  const cancel = () => current.close()
  job.signal?.addEventListener('abort', cancel, { once: true })
  try {
    if (opening) {
      if (!(await opening)) { current.close(); return runCodexNative(job, spec) }
      flog('engine-codex', `${key} takes the spare session`)
    }
    if (!opened) await current.open(native.ready?.() ?? false)
    const result = await current.run(job, fresh)
    if (!key) current.close()
    return result
  } catch (error) {
    current.close()
    return { answer: '', error: job.signal?.aborted ? 'canceled' : error instanceof Error ? error.message : String(error) }
  } finally { job.signal?.removeEventListener('abort', cancel) }
}
