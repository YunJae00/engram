import { AlertTriangle, CircleHelp, PauseCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { DelegatedTaskDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { webPane } from '../lib/webPane.js'
import { useThreadT } from '../lib/useThreadT.js'
import { answerText } from '../markdown.js'
import { renderMarkdown } from '../lib/markdown.js'
import { DecisionCard } from './DecisionCard.js'

// Presses the comet's task left for the person while it went on with the
// rest: each is decided here, and once all are decided the task continues.
// A question or a pause the thread does not already show is a card too.

export function TaskApprovals({ botId, questionShown }: { botId: string; questionShown?: string }) {
  const [task, setTask] = useState<DelegatedTaskDto | null>(null)
  const [pendingDecision, setPendingDecision] = useState(false)
  const [error, setError] = useState('')
  const t = useThreadT(botId)
  useEffect(() => {
    let live = true
    const load = () => void api.tasksList().then((tasks) => {
      if (live) setTask(tasks.filter((one) => one.botId === botId).at(-1) ?? null)
    }).catch(() => undefined)
    load()
    const off = api.onEvent((event) => { if (event.type === 'tasks:changed') load() })
    return () => { live = false; off() }
  }, [botId])
  useEffect(() => {
    if (task?.state === 'waiting') webPane.attention(`bot-${botId}`)
  }, [task, botId])
  if (!task || !['running', 'waiting', 'failed'].includes(task.state)) return null
  if (task.question && answerText(task.question).trim() === answerText(questionShown ?? '').trim()) return null
  const pending = task.approvals.filter((a) => !a.answer)
  if (task.state === 'running' && !pending.length) return null
  if (!pending.length || task.question) {
    // A one-line question is the card's title; a longer one is read below it.
    const said = answerText(task.question ?? task.log.at(-1)?.line ?? 'Task paused.').trim()
    const short = !said.includes('\n') && said.length <= 140
    return (
      <div className="chat-approval decision-stack">
        <DecisionCard
          role="status"
          icon={task.question ? <CircleHelp size={14} /> : <PauseCircle size={14} />}
          label={task.question ? t('card.answerNeeded') : t('card.paused')}
          title={short ? said : undefined}
          sub={task.question ? t('card.replyBelow') : undefined}
        >
          {!short && <div className="bubble-msg-body">{renderMarkdown(said)}</div>}
        </DecisionCard>
      </div>
    )
  }
  const decide = async (id: string, answer: 'approve' | 'decline') => {
    setPendingDecision(true); setError('')
    try { await api.taskDecide(task.id, id, answer) }
    catch (cause) { setError(String(cause)) }
    finally { setPendingDecision(false) }
  }
  return (
    <div className="chat-approval decision-stack" data-testid="task-approvals" role="region" aria-label="Approvals the task left for you">
      {error && <p role="alert">{error}</p>}
      {pending.map((a) => (
        <DecisionCard
          key={a.id}
          testId={`task-approval-${a.id}`}
          hint={t('card.pressHint')}
          icon={<AlertTriangle size={14} />}
          label={`${t('card.needsOk')}${pending.length > 1 ? ` · ${pending.length}` : ''}`}
          title={a.url.startsWith('file:') ? t('card.needsOk') : t('card.press', { words: a.words })}
          sub={a.host}
          actions={<>
            <button className="secondary" disabled={pendingDecision} onClick={() => void decide(a.id, 'decline')}>{t('card.decline')}</button>
            <button className="primary" disabled={pendingDecision} onClick={() => void decide(a.id, 'approve')}>{t('card.continue')}</button>
          </>}
        >
          {a.url.startsWith('file:') && <pre className="approval-command">{a.words}</pre>}
        </DecisionCard>
      ))}
    </div>
  )
}
