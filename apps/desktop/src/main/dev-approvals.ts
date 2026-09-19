import { randomUUID } from 'node:crypto'
import type { DevApproval } from '../shared/developers.js'

export interface DevDecision { decision: 'allow' | 'deny'; remember?: boolean; answers?: Record<string, string[]> }
interface Pending { approval: DevApproval; resolve(value: DevDecision): void; detach(): void }

export class DevApprovals {
  private readonly pending = new Map<string, Pending>()
  private closed = false
  constructor(private readonly changed: (approvals: DevApproval[]) => void,
    private readonly rules?: { find(rule: NonNullable<DevApproval['rule']>): DevDecision | undefined; save(rule: NonNullable<DevApproval['rule']>, decision: DevDecision): void }) {}

  ask(input: Omit<DevApproval, 'id'>, signal: AbortSignal): Promise<DevDecision> {
    if (this.closed || signal.aborted) return Promise.resolve({ decision: 'deny' })
    const saved = input.rule && input.remember ? this.rules?.find(input.rule) : undefined
    if (saved) return Promise.resolve(saved)
    const approval = { ...input, id: randomUUID() }
    return new Promise(resolve => {
      const cancel = () => this.finish(approval.id, { decision: 'deny' })
      this.pending.set(approval.id, { approval, resolve, detach: () => signal.removeEventListener('abort', cancel) })
      signal.addEventListener('abort', cancel, { once: true })
      this.emit()
    })
  }

  respond(id: string, response: DevDecision): void {
    const pending = this.pending.get(id)
    if (!pending || this.closed) throw new Error('This request is no longer waiting for a response.')
    if (!response || !['allow', 'deny'].includes(response.decision)) throw new Error('Invalid approval response.')
    if (response.remember && (!pending.approval.remember || pending.approval.kind !== 'permission')) throw new Error('This decision cannot be saved as a rule.')
    if (response.decision === 'allow' && pending.approval.kind === 'question') {
      const answers = response.answers
      if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Answer the question before continuing.')
      const questions = pending.approval.questions ?? []
      if (Object.keys(answers).some(id => !questions.some(question => question.id === id))) throw new Error('Unknown question.')
      for (const question of questions) {
        const values = answers[question.id]
        if (!Array.isArray(values) || !values.length || values.length > (question.multiple ? 20 : 1)
          || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 8000)) throw new Error('Provide a valid answer to each question.')
      }
    }
    if (response.remember && pending.approval.rule) this.rules?.save(pending.approval.rule, response)
    this.finish(id, response)
  }

  private finish(id: string, decision: DevDecision): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    pending.detach()
    pending.resolve(decision)
    this.emit()
  }
  private emit(): void { this.changed([...this.pending.values()].map(pending => pending.approval)) }
  close(): void {
    this.closed = true
    for (const id of this.pending.keys()) this.finish(id, { decision: 'deny' })
  }
}
