import { BookOpen, ChevronRight } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { StudyDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { sendCometMessage } from '../lib/attachments.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { renderMarkdown } from '../lib/markdown.js'
import { useThreadT } from '../lib/useThreadT.js'
import { DecisionCard } from './DecisionCard.js'

// A job the comet did not know how to do: offered as a study, and what it
// learned brought back to be confirmed. Kept, the job is done again that way.
export function StudyAsk({ botId }: { botId: string }) {
  const t = useThreadT(botId)
  const [study, setStudy] = useState<StudyDto | null>(null)
  const [kept, setKept] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const load = () => void api.studyList(botId).then(list => { if (alive) setStudy(list.at(-1) ?? null) }).catch(() => undefined)
    load()
    const off = api.onEvent(event => { if (event.type === 'study:changed' && event.botId === botId) load() })
    return () => { alive = false; off() }
  }, [botId])
  if (kept) return <DecisionCard testId="study-kept" tone="info" role="status" icon={<BookOpen size={14} />} label={t('study.reviewLabel')} title={t('study.kept')} />
  if (!study || study.state === 'studying') return null
  const answer = async (choice: 'go' | 'later' | 'keep' | 'wrong') => {
    setBusy(true); setError('')
    try {
      const { ask } = await api.studyAnswer(study.id, choice)
      if (choice === 'keep') { setKept(true); if (ask) void sendCometMessage(api, cometThreads, botId, ask) }
    } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause)) }
    finally { setBusy(false) }
  }
  if (study.state === 'offered') return (
    <DecisionCard
      testId="study-offer"
      icon={<BookOpen size={14} />}
      label={t('study.offerLabel')}
      title={study.what}
      sub={error || t('study.offerSub', { where: study.where.length ? study.where.join(', ') : t('study.anywhere') })}
      actions={<>
        <button className="secondary" data-testid="study-later" disabled={busy} onClick={() => void answer('later')}>{t('study.later')}</button>
        <button className="primary" data-testid="study-go" disabled={busy} onClick={() => void answer('go')}>{t('study.go')}</button>
      </>}
    />
  )
  return (
    <DecisionCard
      testId="study-review"
      icon={<BookOpen size={14} />}
      label={t('study.reviewLabel')}
      title={study.findings?.title ?? study.what}
      sub={error || study.findings?.description}
      actions={<>
        <button className="secondary" data-testid="study-wrong" disabled={busy} onClick={() => void answer('wrong')}>{t('study.wrong')}</button>
        <button className="primary" data-testid="study-keep" disabled={busy} onClick={() => void answer('keep')}>{t('study.keep')}</button>
      </>}
    >
      {study.findings && <details className="habit-draft-body"><summary><ChevronRight size={13} aria-hidden />{t('study.details')}</summary><div className="bubble-msg-body">{renderMarkdown(study.findings.body)}</div></details>}
    </DecisionCard>
  )
}
