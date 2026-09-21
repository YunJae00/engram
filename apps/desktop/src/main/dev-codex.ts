import type { DevItem, DevSession, DevUsage } from '../shared/developers.js'
import { codexBinary, withHelpersOnPath } from './engine-cloud.js'
import { DevRpc } from './dev-rpc.js'
import { DevApprovals } from './dev-approvals.js'
import { codexTurnUsage, codexUsage } from './dev-usage.js'
import { accountEnvironment } from './account-profiles.js'
import { devActivity } from './dev-activity.js'

type Data = Record<string, unknown>
const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {}
const string = (value: unknown): string => typeof value === 'string' ? value : ''

export interface DevUpdates {
  item(item: DevItem, append?: boolean): void
  usage(value: DevUsage): void
  finished(error?: string): void
}

export class DevCodex {
  private readonly rpc: DevRpc
  private readonly abort = new AbortController()
  private turnId?: string
  private closed = false
  private readonly items = new Map<string, Data>()

  constructor(private readonly session: DevSession, private readonly approvals: DevApprovals, private readonly updates: DevUpdates) {
    const binary = codexBinary()
    if (!binary) throw new Error('The coding runtime is not available in this installation.')
    this.rpc = new DevRpc(binary, { cwd: session.cwd, env: withHelpersOnPath(binary, accountEnvironment('codex', session.accountProfile ?? 'system')), trustedProject: session.mode === 'full-access' && session.loadProjectSettings === true },
      (method, params) => this.event(method, params), (method, params) => this.request(method, params), error => {
        this.abort.abort(); this.approvals.close()
        if (!this.closed) { this.closed = true; updates.finished(error.message) }
      })
  }

  async start(fork = false): Promise<void> {
    await this.rpc.initialize()
    const full = this.session.mode === 'full-access'
    const result = await this.rpc.send(this.session.runtimeId ? (fork ? 'thread/fork' : 'thread/resume') : 'thread/start', {
      ...(this.session.runtimeId ? { threadId: this.session.runtimeId, excludeTurns: true } : {}),
      cwd: this.session.cwd, ...(this.session.model ? { model: this.session.model } : {}),
      approvalPolicy: full ? 'never' : this.session.mode === 'plan' ? 'on-request' : 'untrusted', approvalsReviewer: 'user',
      sandbox: full ? 'danger-full-access' : this.session.mode === 'auto-edit' ? 'workspace-write' : 'read-only',
      developerInstructions: this.session.mode === 'plan' ? 'Plan and inspect only. Do not modify files, run mutating commands, or request write permissions.' : undefined,
    })
    const thread = object(result['thread'])
    if (!string(thread['id'])) throw new Error('The runtime did not return a development session.')
    this.session.runtimeId = string(thread['id'])
  }

  async send(text: string): Promise<void> {
    if (this.closed || !this.session.runtimeId) throw new Error('The development session is not connected.')
    const result = await this.rpc.send('turn/start', {
      threadId: this.session.runtimeId, input: [{ type: 'text', text, text_elements: [] }],
      ...(this.session.effort ? { effort: this.session.effort } : {}),
    })
    this.turnId = string(object(result['turn'])['id']) || this.turnId
  }
  async commands(): Promise<import('../shared/developers.js').DevCommand[]> {
    const result = await this.rpc.send('skills/list', { cwds: [this.session.cwd] }, 15_000)
    const rows = Array.isArray(result['data']) ? result['data'] : []
    return rows.flatMap(row => {
      const skills = object(row)['skills']
      return Array.isArray(skills) ? skills.filter(skill => object(skill)['enabled'] === true && typeof object(skill)['name'] === 'string').map(skill => ({ name: string(object(skill)['name']), description: string(object(skill)['description']).slice(0, 500), prompt: `$${string(object(skill)['name'])} ` })) : []
    }).slice(0, 200)
  }

  private event(method: string, params: Data): void {
    if (this.closed || (params['threadId'] && params['threadId'] !== this.session.runtimeId)) return
    if (method === 'turn/started') this.turnId = string(object(params['turn'])['id'])
    else if (method === 'turn/completed') {
      this.turnId = undefined
      const turn = object(params['turn']), error = object(turn['error'])
      this.updates.finished(string(error['message']) || (turn['status'] === 'failed' ? 'The runtime could not complete this turn.' : undefined))
    } else if (method === 'thread/tokenUsage/updated') this.updates.usage(codexTurnUsage(params))
    else if (method === 'account/rateLimits/updated') this.updates.usage(codexUsage(params))
    else if (method === 'item/agentMessage/delta') this.updates.item({ id: string(params['itemId']), kind: 'assistant', text: string(params['delta']), status: 'running' }, true)
    else if (method === 'turn/plan/updated') {
      const steps = Array.isArray(params['plan']) ? params['plan'].map(raw => { const step = object(raw); return `${step['status'] === 'completed' ? '[x]' : '[ ]'} ${string(step['step'])}` }).join('\n') : ''
      this.updates.item({ id: `plan-${this.turnId}`, kind: 'plan', text: steps, status: 'running' })
    } else if (method === 'item/commandExecution/outputDelta') {
      const id = string(params['itemId']), item = this.items.get(id)
      if (!item) return
      item['aggregatedOutput'] = (string(item['aggregatedOutput']) + string(params['delta'])).slice(-50_000)
      this.updates.item({ id, kind: 'tool', ...devActivity('commandExecution', item), text: `${string(item['command']) || 'Command'}\n${string(item['aggregatedOutput'])}`, status: 'running' })
    } else if (method === 'item/started' || method === 'item/completed') {
      const incoming = object(params['item']), id = string(incoming['id']), item = { ...this.items.get(id), ...incoming }, type = string(item['type'])
      if (!id || type === 'userMessage') return
      this.items.set(id, item)
      const status = method === 'item/started' ? 'running' : item['status'] === 'failed' || (typeof item['exitCode'] === 'number' && item['exitCode'] !== 0) ? 'failed' : 'done'
      if (type === 'agentMessage' || type === 'plan') this.updates.item({ id, kind: type === 'plan' ? 'plan' : 'assistant', text: string(item['text']), status })
      else if (type === 'commandExecution') this.updates.item({ id, kind: 'tool', ...devActivity(type, item), text: `${string(item['command']) || 'Command details are not available.'}\n${string(item['aggregatedOutput'])}`.trim().slice(0, 50_000), status })
      else if (type === 'fileChange') this.updates.item({ id, kind: 'tool', ...devActivity(type, item), text: this.changes(item) || 'File changes are being prepared.', status })
      else if (type === 'collabAgentToolCall' || type === 'subAgentActivity') this.updates.item({ id, kind: 'agent', text: `${string(item['tool']) || 'Agent'}\n${string(item['prompt']) || string(item['agentPath'])}`, status })
      else if (type !== 'reasoning') this.updates.item({ id, kind: 'tool', text: `${type}${item['tool'] ? ` · ${string(item['tool'])}` : ''}`, status })
      if (method === 'item/completed') this.items.delete(id)
    } else if (method === 'error' && !params['willRetry']) this.updates.finished(string(object(params['error'])['message']) || 'The runtime reported an error.')
  }

  private changes(item: Data): string {
    return Array.isArray(item['changes']) ? item['changes'].map(raw => { const change = object(raw); return `${string(change['path'])}\n${string(change['diff'])}` }).join('\n').slice(0, 100_000) : 'File changes'
  }

  private async request(method: string, params: Data): Promise<unknown> {
    if (this.closed || params['threadId'] !== this.session.runtimeId) throw new Error('This request does not belong to the active development session.')
    if (method === 'item/tool/requestUserInput') {
      const questions = Array.isArray(params['questions']) ? params['questions'].map(raw => {
        const question = object(raw)
        return { id: string(question['id']), text: string(question['question']), options: Array.isArray(question['options']) ? question['options'].map(option => string(object(option)['label'])) : [] }
      }) : []
      if (!questions.length || questions.some(question => !question.id)) throw new Error('The runtime returned an invalid question.')
      const answer = await this.approvals.ask({ kind: 'question', title: 'Your input is needed', detail: '', questions }, this.abort.signal)
      if (answer.decision !== 'allow') throw new Error('The user cancelled this question.')
      return { answers: Object.fromEntries(Object.entries(answer.answers ?? {}).map(([id, answers]) => [id, { answers }])) }
    }
    if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(method)) throw new Error('This permission request is not supported; no permission was granted.')
    if (this.session.mode === 'plan') return { decision: 'decline' }
    const file = method === 'item/fileChange/requestApproval'
    const item = this.items.get(string(params['itemId']))
    if (file && (!Array.isArray(item?.['changes']) || !item['changes'].length)) throw new Error('The runtime did not provide a change preview. No file changes were approved.')
    const detail = file ? this.changes(item!) : string(params['command'])
    if (!detail.trim()) throw new Error('The runtime did not describe this command. No permission was granted.')
    const answer = await this.approvals.ask({ kind: 'permission', title: file ? 'Allow file changes?' : 'Allow this command?', detail: `${detail}\n${string(params['reason'])}`.trim() }, this.abort.signal)
    return { decision: answer.decision === 'allow' ? 'accept' : 'decline' }
  }

  async stop(): Promise<void> {
    if (this.closed) { await this.rpc.shutdown(); return }
    this.closed = true; this.abort.abort(); this.approvals.close()
    try { if (this.turnId && this.session.runtimeId) await this.rpc.send('turn/interrupt', { threadId: this.session.runtimeId, turnId: this.turnId }, 5000) }
    finally { await this.rpc.shutdown(); this.updates.finished() }
  }
}
