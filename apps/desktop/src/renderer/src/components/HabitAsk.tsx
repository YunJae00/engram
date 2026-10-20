import { Route } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { HabitDraftDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useThreadT } from '../lib/useThreadT.js'
import { DecisionCard } from './DecisionCard.js'

// A way of working Engram noticed, raised in its own conversation: keep it as
// a how-to or set it aside. Anything said in the conversation first is folded
// in when it is kept.
export function HabitAsk({ botId }: { botId: string }) {
  const t = useThreadT(botId)
  const [draft, setDraft] = useState<HabitDraftDto | null>(null)
  const [done, setDone] = useState<'kept' | 'dismissed' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = () => void api.habitsList().then(list => { if (alive) setDraft(list.find(one => one.botId === botId) ?? null) }).catch(() => undefined)
    load()
    const off = api.onEvent(event => { if (event.type === 'habits:changed') load() })
    return () => { alive = false; off() }
  }, [botId])
  if (done) return <DecisionCard testId="habit-ask-done" tone="info" role="status" icon={<Route size={14} />} label={t('habit.label')} title={t(done === 'kept' ? 'habit.kept' : 'habit.dismissed')} />
  if (!draft) return null
  const answer = async (keep: boolean) => {
    setBusy(true); setError('')
    try { await api.habitsAnswer(draft.key, keep); setDone(keep ? 'kept' : 'dismissed') }
    catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause)) }
    finally { setBusy(false) }
  }
  return (
    <DecisionCard
      testId="habit-ask"
      icon={<Route size={14} />}
      label={t('habit.label')}
      title={draft.title}
      sub={<>{t('habit.seen', { apps: draft.labels.join(' → '), times: draft.times })}<br />{error || t('habit.answerBelow')}</>}
      actions={<>
        <button className="secondary" data-testid="habit-ask-no" disabled={busy} onClick={() => void answer(false)}>{t('habit.no')}</button>
        <button className="primary" data-testid="habit-ask-keep" disabled={busy} onClick={() => void answer(true)}>{t('habit.keep')}</button>
      </>}
    />
  )
}
