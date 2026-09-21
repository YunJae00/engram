import { createHash, randomUUID } from 'node:crypto'
import type { DevItem, DevSession } from '../shared/developers.js'
import { installedClaudeBinary, loadClaudeSdk } from './claude-runtime.js'
import { spawnRuntime, type ProcessClient } from './process-client.js'
import { DevApprovals } from './dev-approvals.js'
import { devEditPreview, devLocalPath } from './dev-edit.js'
import { claudeTurnUsage, claudeUsage } from './dev-usage.js'
import type { DevUpdates } from './dev-codex.js'
import type { SdkUserMessage } from './engine-claude-session.js'
import { accountEnvironment, activeAccountProfile } from './account-profiles.js'
import { devActivity } from './dev-activity.js'
import { devClaudeInstructions } from './dev-instructions.js'

type Data = Record<string, unknown>
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const text = (value: unknown): string => typeof value === 'string' ? value : ''
interface Query extends AsyncIterable<Data> { interrupt(): Promise<unknown>; supportedCommands?(): Promise<{ name: string; description: string }[]>; usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options: { skipBehaviors: boolean }) => Promise<unknown> }
interface Sdk { query(options: { prompt: AsyncIterable<SdkUserMessage>; options: Data }): Query }

export async function claudeProbe<T>(cwd: string, request: (query: Query) => Promise<T>, profile = activeAccountProfile('claude')): Promise<T> {
  const env = accountEnvironment('claude', profile)
  const abort = new AbortController(), processes = new Set<ProcessClient>()
  const timer = setTimeout(() => abort.abort(), 60_000)
  try {
    const sdk = await loadClaudeSdk() as Sdk, binary = installedClaudeBinary()
    if (!binary) throw new Error('Connect Claude in AI settings first.')
    const prompt = (async function* () { await new Promise<void>(resolve => { if (abort.signal.aborted) resolve(); else abort.signal.addEventListener('abort', () => resolve(), { once: true }) }); if (!abort.signal.aborted) yield undefined as never })()
    const query = sdk.query({ prompt, options: { cwd, env, pathToClaudeCodeExecutable: binary, abortController: abort, tools: [], persistSession: false, settingSources: [], strictMcpConfig: true, maxTurns: 1, spawnClaudeCodeProcess: (options: Parameters<typeof spawnRuntime>[0]) => { const child = spawnRuntime({ ...options, killTree: true }); processes.add(child); return child } } })
    return await Promise.race([request(query), new Promise<never>((_, reject) => { if (abort.signal.aborted) reject(new Error('Timed out')); else abort.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true }) })])
  }
  finally { clearTimeout(timer); abort.abort(); await Promise.all([...processes].map(child => { child.kill(); return child.waitForClose() })) }
}

export async function claudeAccountUsage(cwd: string, profile = activeAccountProfile('claude')): Promise<import('../shared/developers.js').DevUsage> {
  try { return await claudeProbe(cwd, async query => {
    await query.supportedCommands?.()
    if (!query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) return { unavailable: 'This Claude runtime does not report account limits.' }
    return claudeUsage(await query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }))
  }, profile) } catch { return { unavailable: 'Claude account limits could not be refreshed. Check your connection and try again.' } }
}

export class DevClaude {
  private query?: Query
  private readonly abort = new AbortController()
  private readonly queue: SdkUserMessage[] = []
  private wake?: () => void
  private closed = false
  private messageId: string = randomUUID()
  private readonly readTools = new Set(['Read', 'Glob', 'Grep', 'LS'])
  private readonly processes = new Set<ProcessClient>()
  private readonly tools = new Map<string, DevItem>()
  constructor(private readonly session: DevSession, private readonly approvals: DevApprovals, private readonly updates: DevUpdates) {}

  async start(fork = false): Promise<void> {
    const sdk = await loadClaudeSdk() as Sdk, binary = installedClaudeBinary()
    if (this.closed) throw new Error('The development session was stopped.')
    if (!binary) throw new Error('Install and connect Claude in AI settings first.')
    const extensions = this.session.mode === 'full-access' && this.session.loadProjectSettings === true
    const guidance = extensions ? '' : await devClaudeInstructions(this.session.cwd)
    if (this.closed) throw new Error('The development session was stopped.')
    this.query = sdk.query({ prompt: this.input(), options: {
      cwd: this.session.cwd, pathToClaudeCodeExecutable: binary, spawnClaudeCodeProcess: (options: Parameters<typeof spawnRuntime>[0]) => {
        const child = spawnRuntime({ ...options, killTree: true })
        this.processes.add(child); child.once('close', () => this.processes.delete(child))
        return child
      },
      env: accountEnvironment('claude', this.session.accountProfile ?? 'system'),
      abortController: this.abort, includePartialMessages: true, persistSession: true,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: [this.session.mode === 'plan' ? 'Inspect and plan only. Do not modify files or run mutating commands.' : '', guidance].filter(Boolean).join('\n\n') },
      settingSources: this.session.mode === 'full-access' && this.session.loadProjectSettings ? ['user', 'project', 'local'] : [], strictMcpConfig: !(this.session.mode === 'full-access' && this.session.loadProjectSettings), permissionMode: 'default',
      ...(this.session.model ? { model: this.session.model } : {}), ...(this.session.effort ? { effort: this.session.effort } : {}),
      ...(this.session.runtimeId ? { resume: this.session.runtimeId, forkSession: fork } : {}),
      hooks: { PreToolUse: [{ hooks: [async (raw: Data, _id: string, options: { signal: AbortSignal }) => {
        if (raw['tool_name'] === 'AskUserQuestion') return {}
        const decision = await this.permission(text(raw['tool_name']), object(raw['tool_input']), options.signal)
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision.behavior, permissionDecisionReason: decision.message, ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}) } }
      }] }] },
      canUseTool: async (name: string, input: Data, options: { signal: AbortSignal }) => this.permission(name, input, options.signal),
    } })
    void this.pump(this.query)
  }

  private async permission(name: string, input: Data, signal: AbortSignal): Promise<{ behavior: 'allow' | 'deny'; message?: string; updatedInput?: Data }> {
    const deny = { behavior: 'deny' as const, message: 'This action was not approved.' }
    if (this.closed || signal.aborted || this.abort.signal.aborted) return deny
    if (name === 'AskUserQuestion') {
      const questions = Array.isArray(input['questions']) ? input['questions'].map((raw, index) => {
        const question = object(raw)
        return { id: String(index), text: text(question['question']), multiple: question['multiSelect'] === true, options: Array.isArray(question['options']) ? question['options'].map(option => text(object(option)['label'])) : [] }
      }) : []
      if (!questions.length) return deny
      const answer = await this.approvals.ask({ kind: 'question', title: 'Your input is needed', detail: '', questions }, signal)
      if (answer.decision === 'deny' || this.closed) return deny
      return { behavior: 'allow', updatedInput: { ...input, answers: Object.fromEntries(questions.map(question => [question.text, (answer.answers?.[question.id] ?? []).join(', ')])) } }
    }
    if (['TodoWrite', 'TaskList', 'TaskGet'].includes(name)) return { behavior: 'allow' }
    if (this.readTools.has(name) && await devLocalPath(this.session.cwd, input['file_path'] ?? input['path'] ?? '.')) return { behavior: 'allow' }
    if (this.session.mode === 'plan') return { behavior: 'deny', message: 'This task is in read-only plan mode. Switch modes to make changes or run commands.' }
    if (this.session.mode === 'full-access') return { behavior: 'allow' }
    const preview = await devEditPreview(this.session.cwd, name, input)
    if (this.session.mode === 'auto-edit' && preview) return { behavior: 'allow' }
    const answer = await this.approvals.ask({ kind: 'permission', title: `Allow ${name}?`, detail: JSON.stringify(input, null, 2).slice(0, 100_000), ...(preview ? { changes: [preview], remember: true, rule: { tool: name, input: createHash('sha256').update(JSON.stringify(input)).update('\0').update(preview.before).digest('hex') } } : {}) }, signal)
    if (answer.decision !== 'allow' || this.closed || signal.aborted) return deny
    if (preview) {
      const fresh = await devEditPreview(this.session.cwd, name, input)
      if (!fresh || fresh.before !== preview.before || fresh.after !== preview.after) return { behavior: 'deny', message: 'The file changed while approval was open. Read it again and request a fresh approval.' }
    }
    return { behavior: 'allow' }
  }

  private async *input(): AsyncGenerator<SdkUserMessage> {
    while (!this.closed) {
      const next = this.queue.shift()
      if (next) yield next
      else await new Promise<void>(resolve => { this.wake = resolve })
    }
  }
  async send(content: string): Promise<void> {
    if (this.closed || !this.query) throw new Error('The development session is not connected.')
    this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: this.session.runtimeId ?? '' })
    this.wake?.(); this.wake = undefined
  }

  private async pump(query: Query): Promise<void> {
    try {
      for await (const message of query) {
        if (this.closed) break
        if (message['type'] === 'system' && message['subtype'] === 'init') { this.session.runtimeId = text(message['session_id']) || this.session.runtimeId; this.session.forkOnStart = false }
        else if (message['type'] === 'stream_event') {
          const event = object(message['event']), delta = object(event['delta'])
          if (event['type'] === 'message_start') this.messageId = text(object(event['message'])['id']) || randomUUID()
          if (delta['type'] === 'text_delta') this.updates.item({ id: this.messageId, kind: 'assistant', text: text(delta['text']), status: 'running' }, true)
        } else if (message['type'] === 'assistant') {
          const content = object(message['message'])['content']
          if (!Array.isArray(content)) continue
          const spoken = content.map(raw => { const block = object(raw); return block['type'] === 'text' ? text(block['text']) : '' }).join('')
          if (spoken) this.updates.item({ id: text(object(message['message'])['id']) || this.messageId, kind: 'assistant', text: spoken, status: 'done' })
          for (const raw of content) {
            const block = object(raw)
            if (block['type'] === 'tool_use') {
              const name = text(block['name']), input = object(block['input'])
              const item: DevItem = { id: text(block['id']), ...devActivity(name, input), kind: ['Agent', 'Task'].includes(name) ? 'agent' : name === 'TodoWrite' ? 'plan' : 'tool', text: `${name}\n${text(input['command']) || JSON.stringify(input, null, 2)}`.slice(0, 50_000), status: 'running' }
              this.tools.set(item.id, item); this.updates.item(item)
            }
          }
        } else if (message['type'] === 'user') {
          const content = object(message['message'])['content']
          if (!Array.isArray(content)) continue
          for (const raw of content) {
            const block = object(raw)
            if (block['type'] === 'tool_result') {
              const id = text(block['tool_use_id']), previous = this.tools.get(id)
              const result = typeof block['content'] === 'string' ? block['content'] : JSON.stringify(block['content'] ?? '')
              this.updates.item({ ...previous, id, kind: previous?.kind ?? 'tool', text: `${previous?.text ?? 'Tool'}\n\n${result}`.slice(0, 50_000), status: block['is_error'] ? 'failed' : 'done' })
              this.tools.delete(id)
            }
          }
        } else if (message['type'] === 'result') {
          this.updates.usage(claudeTurnUsage(message))
          this.updates.finished(message['is_error'] ? (Array.isArray(message['errors']) ? message['errors'].join('; ') : text(message['result']) || text(message['subtype'])) : undefined)
        }
      }
      if (!this.closed) this.updates.finished('The development runtime disconnected.')
    } catch (error) { if (!this.closed) this.updates.finished(error instanceof Error ? error.message : 'The development runtime failed.') }
    finally { this.closed = true; this.abort.abort(); this.approvals.close(); this.wake?.() }
  }

  async usage(): Promise<import('../shared/developers.js').DevUsage> {
    const read = this.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET
    if (!read) return { unavailable: 'Account limits are not available for this connection.' }
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return claudeUsage(await Promise.race([read.call(this.query, { skipBehaviors: true }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Usage request timed out.')), 15_000) })])) }
    catch { return { unavailable: 'Account limits could not be refreshed. Try again later.' } }
    finally { clearTimeout(timer) }
  }
  async commands(): Promise<import('../shared/developers.js').DevCommand[]> {
    if (!this.query?.supportedCommands) throw new Error('This runtime does not report available skills.')
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const rows = await Promise.race([this.query.supportedCommands(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Skills did not load in time.')), 15_000) })])
      return rows.filter(row => typeof row.name === 'string').slice(0, 200).map(row => ({ name: row.name, description: String(row.description ?? '').slice(0, 500), prompt: `/${row.name} ` }))
    } finally { clearTimeout(timer) }
  }
  async stop(): Promise<void> {
    try {
      if (!this.closed) {
        this.closed = true; this.approvals.close(); this.wake?.()
        const timer = setTimeout(() => this.abort.abort(), 5000)
        try { await this.query?.interrupt() }
        catch (error) {
          // A closed query cannot acknowledge interruption; owned processes are still reaped below.
          if (!(error instanceof Error) || !/Query closed before response received/.test(error.message)) throw error
        }
        finally { clearTimeout(timer); this.abort.abort(); this.updates.finished() }
      }
    } finally { await Promise.all([...this.processes].map(child => { child.kill(); return child.waitForClose() })) }
  }
}
