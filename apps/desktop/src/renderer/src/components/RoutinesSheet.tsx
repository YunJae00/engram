import { AlertTriangle, Play, Repeat, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ApprovalRuleDto, RoutineDto } from '../../../shared/types.js'
import { ApprovalChips } from './ApprovalChips.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import { DialogHeader } from './DialogHeader.js'
import { LiveView } from './LiveView.js'
import { RoutineProgress } from './RoutineProgress.js'
import { SubmitGate } from './SubmitGate.js'

// The jobs a comet has learned to do on a website, and what it is allowed to
// press there. Nothing is authored here: a comet does the job itself, and
// what it learned is kept afterwards - so this sheet is a record to look at,
// run again, or forget.

export function RoutinesSheet({ onClose }: { onClose(): void }) {
  const { t, routine, routineWall, answerRoutineWall } = useApp()
  const [routines, setRoutines] = useState<RoutineDto[]>([])
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const [rules, setRules] = useState<ApprovalRuleDto[]>([])

  useEscape(onClose, true)

  const reload = () => {
    void api.routinesList().then(setRoutines).catch(() => {})
    void api.approvalsList().then(setRules).catch(() => {})
  }

  useEffect(() => {
    reload()
    return api.onEvent((event) => {
      // vault:changed too: a routine is a note now, so one appearing (sync,
      // another window, a fresh save) must show up without reopening.
      if (event.type === 'routine:logged' || event.type === 'vault:changed') reload()
    })
  }, [])

  const run = (routineId: string) => {
    onClose()
    window.dispatchEvent(new CustomEvent('engram:run-routine', { detail: { routineId } }))
  }

  const remove = (id: string) => {
    if (armedDelete !== id) {
      setArmedDelete(id)
      return
    }
    setArmedDelete(null)
    void api.routineRemove(id).then(reload)
  }

  const when = (iso: string): string =>
    new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="brief-overlay" onClick={onClose}>
      <div className="brief-box errands-box" onClick={(e) => e.stopPropagation()} data-testid="routines-sheet">
        <DialogHeader
          closeLabel={t('routines.cancel')}
          icon={<Repeat size={15} aria-hidden />}
          onClose={onClose}
        >
          {t('routines.title')}
        </DialogHeader>
        <div className="errands-hint">{t('routines.hint')}</div>

        {routine.running && !routine.channel && <>
          <RoutineProgress />
          <LiveView open={routineWall !== null && !routineWall.channel}>
            {routineWall && !routineWall.channel && <button className="errand-wall-done" data-testid="scheduled-routine-wall-done" onClick={() => answerRoutineWall('resolved')}>{t('routines.wallDone')}</button>}
          </LiveView>
          <SubmitGate />
          <button className="secondary" data-testid="scheduled-routine-stop" onClick={() => void api.routineAbort()}>Stop</button>
        </>}

        {routines.length === 0 ? (
          <div className="errands-empty">{t('routines.empty')}</div>
        ) : (
          <ul className="routines-list">
            {routines.map((r) => (
              <li key={r.id} className="routine-row" data-testid={`routine-row-${r.id}`}>
                {r.lastOutcome !== undefined && <span className={`errand-outcome ${r.lastOutcome}`} />}
                <span className="routine-row-main">
                  <span className="errand-run-goal">{r.name}</span>
                  <span className="errand-run-meta">
                    {t('routines.steps', { n: r.steps.length })}
                    {r.lastRunAt !== undefined && <> · {t('routines.lastRun', { when: when(r.lastRunAt) })}</>}
                    {r.pendingWrite !== undefined && (
                      <span className="routine-warn" title={t('routines.unfinishedHint')}>
                        <AlertTriangle size={11} aria-hidden /> {t('routines.unfinished')}
                      </span>
                    )}
                  </span>
                  <ApprovalChips
                    rules={rules.filter((rule) => rule.routineId === r.id)}
                    onForget={(fingerprint) => void api.approvalForget(fingerprint).then(reload)}
                  />
                </span>
                <button
                  className="secondary routine-run"
                  data-testid={`routine-run-${r.id}`}
                  onClick={() => run(r.id)}
                >
                  <Play size={11} strokeWidth={2.5} aria-hidden /> {t('routines.run')}
                </button>
                <button
                  className={`routine-delete${armedDelete === r.id ? ' armed' : ''}`}
                  aria-label={t('routines.delete')}
                  title={armedDelete === r.id ? t('routines.deleteArmed') : t('routines.delete')}
                  onClick={() => remove(r.id)}
                >
                  <X size={12} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
