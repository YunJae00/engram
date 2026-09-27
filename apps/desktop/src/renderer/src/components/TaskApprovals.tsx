import { AlertTriangle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DelegatedTaskDto } from '../../../shared/types.js'
import { api } from '../api.js'

// Presses the comet's task left for the person while it went on with the
// rest: each is decided here, and once all are decided the task continues.

export function TaskApprovals({ botId }: { botId: string }) {
  const [task, setTask] = useState<DelegatedTaskDto | null>(null)
  const [pendingDecision, setPendingDecision] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    const load = () => void api.tasksList().then((tasks) => {
      if (live) setTask(tasks.filter((one) => one.botId === botId).at(-1) ?? null)
    }).catch(() => undefined)
    load()
    const off = api.onEvent((event) => { if (event.type === 'tasks:changed') load() })
    return () => { live = false; off() }
  }, [botId])
  if (!task || !['waiting', 'failed'].includes(task.state)) return null
  const pending = task.approvals.filter((a) => !a.answer)
  if (!pending.length || task.question) return <section className="routine-submit chat-approval" role="status">{task.question ?? task.log.at(-1)?.line ?? 'Task paused.'}</section>
  const decide = async (id: string, answer: 'approve' | 'decline') => {
    setPendingDecision(true); setError('')
    try { await api.taskDecide(task.id, id, answer) }
    catch (cause) { setError(String(cause)) }
    finally { setPendingDecision(false) }
  }
  return (
    <section className="routine-submit chat-approval" data-testid="task-approvals" role="region" aria-label="Approvals the task left for you">
      <strong role="status">Waiting for your approval · {pending.length}</strong>
      <div className="routine-submit-hint">Choose which actions to continue. You'll confirm on the current page before anything is submitted.</div>
      {error && <p role="alert">{error}</p>}
      {pending.map((a) => (
        <div key={a.id} className="dialog-actions" data-testid={`task-approval-${a.id}`}>
          <div className="routine-submit-head"><AlertTriangle size={14} aria-hidden /> Press "{a.words}" on {a.host}</div>
          <button className="secondary" disabled={pendingDecision} onClick={() => void decide(a.id, 'decline')}>Decline</button>
          <button className="primary" disabled={pendingDecision} onClick={() => void decide(a.id, 'approve')}>Review and continue</button>
        </div>
      ))}
    </section>
  )
}
