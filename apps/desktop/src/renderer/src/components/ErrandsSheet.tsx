import { Ghost, Square } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ErrandRunDto } from '../../../shared/types.js'
import { api } from '../api.js'
import type { StringKey } from '../i18n.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'

// The errand's home. The dialog this replaces could only START a run —
// everything after the click was a one-line top-bar narration and a toast,
// which is why delegation read as a side feature. Here the run is watchable
// (each phase with what it has in hand), stoppable, and past delegations
// stay on the record with a door to the proposal they produced.

const PHASES = ['plan', 'gather', 'web', 'distill', 'compose'] as const

const PHASE_LABEL: Record<string, StringKey> = {
  plan: 'topbar.errandPlan',
  gather: 'topbar.errandGather',
  web: 'topbar.errandWeb',
  distill: 'topbar.errandDistill',
  compose: 'topbar.errandCompose',
}

export function ErrandsSheet({ onClose }: { onClose(): void }) {
  const { errand, errandWall, answerErrandWall, startErrand, openReview, selectCard, cards, t } = useApp()
  const [goal, setGoal] = useState('')
  const [history, setHistory] = useState<ErrandRunDto[]>([])

  useEscape(onClose, true)

  useEffect(() => {
    const reload = () => void api.errandJournal().then(setHistory).catch(() => {})
    reload()
    return api.onEvent((event) => {
      if (event.type === 'errand:logged') reload()
    })
  }, [])

  const submit = () => {
    const trimmed = goal.trim()
    if (!trimmed || errand.running) return
    void startErrand(trimmed)
    setGoal('')
  }

  const detailFor = (phase: string): string => {
    if (phase === 'plan' && errand.queries) return errand.queries.join(' · ')
    if (phase === 'gather' && errand.notes !== undefined) return t('errands.sources', { n: errand.notes })
    if (phase === 'web' && errand.pages) return errand.pages.map((p) => p.title || p.url).join(' · ')
    if (phase === 'distill' && errand.points !== undefined) return t('errands.points', { n: errand.points })
    return ''
  }

  const outcomeKey: Record<ErrandRunDto['outcome'], StringKey> = {
    done: 'errands.outcomeDone',
    failed: 'errands.outcomeFailed',
    aborted: 'errands.outcomeAborted',
  }

  // The run's product is a proposal card; while it still awaits a verdict the
  // row carries a door straight into review.
  const openResult = (run: ErrandRunDto) => {
    if (!run.cardId || !cards.some((c) => c.id === run.cardId)) return
    selectCard(run.cardId)
    openReview()
    onClose()
  }

  const when = (iso: string): string =>
    new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="brief-overlay" onClick={onClose}>
      <div className="brief-box errands-box" onClick={(e) => e.stopPropagation()} data-testid="errands-sheet">
        <div className="brief-title errands-title">
          <Ghost size={16} strokeWidth={1.8} aria-hidden /> {t('errands.title')}
        </div>
        <div className="errands-hint">{t('errands.hint')}</div>

        <textarea
          autoFocus
          className="errand-input"
          data-testid="errand-goal"
          placeholder={t('errand.placeholder')}
          value={goal}
          disabled={errand.running}
          onChange={(e) => setGoal(e.target.value)}
          // Enter delegates; Shift+Enter is a newline, as the box is multi-line.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div className="dialog-actions">
          <button className="primary" data-testid="errand-delegate" disabled={errand.running || !goal.trim()} onClick={submit}>
            {errand.running ? t('errands.busy') : t('errand.start')}
          </button>
        </div>

        {errand.running && (
          <div className="errand-live" data-testid="errand-live">
            <div className="errand-live-goal">{errand.goal}</div>
            <ul className="errand-steps">
              {PHASES.map((phase) => {
                const reached = errand.timeline.some((step) => step.phase === phase)
                const current = errand.phase === phase
                const detail = detailFor(phase)
                return (
                  <li key={phase} className={`errand-step${current ? ' current' : reached ? ' passed' : ''}`}>
                    {t(PHASE_LABEL[phase]!)}
                    {reached && detail && <span className="errand-step-detail">{detail}</span>}
                  </li>
                )
              })}
            </ul>
            {errandWall && (
              <div className="errand-wall-inline">
                <span>{t(errandWall.wall === 'login' ? 'errand.wallLogin' : 'errand.wallCaptcha')}</span>
                <button className="errand-wall-done" onClick={() => answerErrandWall('resolved')}>
                  {t('errand.wallDone')}
                </button>
                <button className="errand-wall-skip" onClick={() => answerErrandWall('skip')}>
                  {t('errand.wallSkip')}
                </button>
              </div>
            )}
            <button className="secondary errand-stop" onClick={() => void api.errandAbort()}>
              <Square size={11} strokeWidth={2.5} aria-hidden /> {t('errands.stop')}
            </button>
          </div>
        )}

        <div className="errands-history-title">{t('errands.historyTitle')}</div>
        {history.length === 0 ? (
          <div className="errands-empty">{t('errands.empty')}</div>
        ) : (
          <ul className="errands-history">
            {history.map((run) => (
              <li key={run.id} className="errand-run">
                <span className={`errand-outcome ${run.outcome}`} title={t(outcomeKey[run.outcome])} />
                <span className="errand-run-main">
                  <span className="errand-run-goal">{run.title ?? run.goal}</span>
                  <span className="errand-run-meta">
                    {when(run.startedAt)}
                    {run.noteSources > 0 && <> · {t('errands.sources', { n: run.noteSources })}</>}
                    {run.pages.length > 0 && <> · {t('errands.pages', { n: run.pages.length })}</>}
                    {run.error && <> · {run.error}</>}
                  </span>
                </span>
                {run.cardId !== undefined && cards.some((c) => c.id === run.cardId) && (
                  <button className="secondary errand-run-review" onClick={() => openResult(run)}>
                    {t('errands.review')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
