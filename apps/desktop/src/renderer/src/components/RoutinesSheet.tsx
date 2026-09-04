import { AlertTriangle, Play, Repeat, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ApprovalRuleDto, RoutineBlockDto, RoutineDto } from '../../../shared/types.js'
import { ApprovalChips } from './ApprovalChips.js'
import { LiveView } from './LiveView.js'
import { SubmitGate } from './SubmitGate.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import { DialogHeader } from './DialogHeader.js'

// The jobs a comet has learned to do on a website, and what it is allowed to
// press there. Nothing is authored here: a comet does the job itself, and
// what it learned is kept afterwards - so this sheet is a record to look at,
// run again, or forget.

export function RoutinesSheet({ onClose }: { onClose(): void }) {
  const { routine, routineWall, answerRoutineWall, startRoutine, errand, t } = useApp()
  const [routines, setRoutines] = useState<RoutineDto[]>([])
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  // A refused rerun is a question, asked right where it was answered.
  const [ask, setAsk] = useState<{ id: string; name: string; blocked: RoutineBlockDto } | null>(null)
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

  const busy = routine.running || errand.running

  const run = async (id: string, name: string, force = false) => {
    setAsk(null)
    const result = await startRoutine(id, name, force)
    if (result.blocked) setAsk({ id, name, blocked: result.blocked })
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

        {routine.running && (
          <div className="errand-live" data-testid="routine-live">
            <div className="errand-live-goal">{routine.name ?? t('routines.running')}</div>
            <ul className="errand-steps">
              {routine.steps.map((step, i) => {
                const current = i === routine.steps.length - 1
                return (
                  <li key={`${i}-${step.label}`} className={`errand-step${current ? ' current' : ' passed'}`}>
                    {step.label}
                    {current && routine.step && (
                      <span className="errand-step-detail">{`${routine.step.index + 1}/${routine.step.total}`}</span>
                    )}
                  </li>
                )
              })}
            </ul>
            {routineWall && (
              <div className="errand-wall-inline">
                <span>{t(routineWall.wall === 'login' ? 'routines.wallLogin' : 'routines.wallCaptcha')}</span>
                <button className="errand-wall-done" data-testid="routine-wall-done" onClick={() => answerRoutineWall('resolved')}>
                  {t('routines.wallDone')}
                </button>
                <button className="errand-wall-skip" onClick={() => answerRoutineWall('skip')}>
                  {t('routines.wallStop')}
                </button>
              </div>
            )}
            <LiveView open={routineWall !== null}>
              {routineWall && (
                <button className="errand-wall-done" data-testid="routine-wall-done-live" onClick={() => answerRoutineWall('resolved')}>
                  {t('routines.wallDone')}
                </button>
              )}
            </LiveView>
            <SubmitGate />
            <button className="secondary errand-stop" onClick={() => void api.routineAbort()}>
              <Square size={11} strokeWidth={2.5} aria-hidden /> {t('routines.stop')}
            </button>
          </div>
        )}

        {ask && (
          <div className="routine-ask" data-testid="routine-ask">
            <AlertTriangle size={14} aria-hidden />
            <span className="routine-ask-text">
              {t(ask.blocked === 'already-ran-today' ? 'routines.askRanToday' : 'routines.askUnfinished', {
                name: ask.name,
              })}
            </span>
            <button className="primary" data-testid="routine-ask-yes" onClick={() => void run(ask.id, ask.name, true)}>
              {t('routines.askRun')}
            </button>
            <button className="secondary" onClick={() => setAsk(null)}>
              {t('routines.cancel')}
            </button>
          </div>
        )}

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
                  disabled={busy}
                  onClick={() => void run(r.id, r.name)}
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
