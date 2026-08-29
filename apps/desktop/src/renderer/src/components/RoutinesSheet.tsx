import { AlertTriangle, Eye, Play, Repeat, Square, Wand2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApprovalRuleDto, RoutineBlockDto, RoutineDto, RoutineStepDto } from '../../../shared/types.js'
import { ApprovalChips } from './ApprovalChips.js'
import { LiveView } from './LiveView.js'
import { stepLine } from '../lib/routineSteps.js'
import { SubmitGate } from './SubmitGate.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'

// Routines are the repetition with the thinking already done: the pages and
// clicks a person walks every day, saved once, replayed with one press. A
// routine is only ever taught — the person does the job once in the browser
// and the moves are kept — so there is no form to fill and nothing to learn.

export function RoutinesSheet({ startTeaching, onClose }: { startTeaching?: boolean; onClose(): void }) {
  const { routine, routineWall, answerRoutineWall, startRoutine, errand, showToast, t } = useApp()
  const [routines, setRoutines] = useState<RoutineDto[]>([])
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  // A refused rerun is a question, asked right where it was answered.
  const [ask, setAsk] = useState<{ id: string; name: string; blocked: RoutineBlockDto } | null>(null)
  // Teach mode: the agent window is open and recording; when it ends, the
  // captured steps wait here under a name box until the person keeps them.
  const [teaching, setTeaching] = useState(false)
  const [taught, setTaught] = useState<RoutineStepDto[] | null>(null)
  const [taughtName, setTaughtName] = useState('')

  useEscape(onClose, true)

  const [rules, setRules] = useState<ApprovalRuleDto[]>([])
  const reload = () => {
    void api.routinesList().then(setRoutines).catch(() => {})
    void api.approvalsList().then(setRules).catch(() => {})
  }

  useEffect(() => {
    reload()
    // A lesson that was under way when this sheet last closed is still being
    // recorded; reopening shows it where it was left, not a fresh start.
    void api
      .routineTeachState()
      .then((state) => {
        if (state.teaching) setTeaching(true)
      })
      .catch(() => {})
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

  const teachStart = useCallback(async () => {
    const started = await api.routineTeachStart()
    if (!started.ok) {
      showToast(started.error ?? t('routines.teachFailed'))
      return
    }
    setTaught(null)
    setTeaching(true)
  }, [showToast, t])

  // Opened by "show me how": begin watching immediately, so the person is
  // in the browser doing the job rather than hunting for the button.
  const askedToTeach = useRef(false)
  useEffect(() => {
    if (!startTeaching || askedToTeach.current) return
    askedToTeach.current = true
    void teachStart()
  }, [startTeaching, teachStart])

  const teachStop = async (keep: boolean) => {
    const steps = await api.routineTeachStop().catch(() => [] as RoutineStepDto[])
    setTeaching(false)
    if (!keep) return
    if (steps.length === 0) {
      showToast(t('routines.teachEmpty'))
      return
    }
    setTaught(steps)
    setTaughtName('')
  }

  const keepTaught = async () => {
    if (!taught || taught.length === 0 || !taughtName.trim()) return
    try {
      await api.routineAdd({ name: taughtName, steps: taught })
      setTaught(null)
      setTaughtName('')
      reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message.replace(/^.*Error: /, '') : String(err))
    }
  }

  const remove = (id: string) => {
    if (armedDelete !== id) {
      setArmedDelete(id)
      return
    }
    setArmedDelete(null)
    void api.routineRemove(id).then(reload)
  }

  // The lesson's controls sit on the sheet and on the large view alike, so
  // Done is at hand wherever the person is looking.
  const teachButtons = (live: boolean) => (
    <>
      <button className="secondary" data-testid={`routine-teach-cancel${live ? '-live' : ''}`} onClick={() => void teachStop(false)}>
        {t('routines.cancel')}
      </button>
      <button className="secondary" data-testid={`routine-teach-read${live ? '-live' : ''}`} onClick={() => void api.routineTeachRead()}>
        {t('routines.teachRead')}
      </button>
      <button className="primary" data-testid={`routine-teach-done${live ? '-live' : ''}`} onClick={() => void teachStop(true)}>
        {t('routines.teachDone')}
      </button>
    </>
  )
  const wallButtons = (live: boolean) => (
    <>
      <button className="errand-wall-done" data-testid={`routine-wall-done${live ? '-live' : ''}`} onClick={() => answerRoutineWall('resolved')}>
        {t('routines.wallDone')}
      </button>
      <button className="errand-wall-skip" onClick={() => answerRoutineWall('skip')}>
        {t('routines.wallStop')}
      </button>
    </>
  )

  const when = (iso: string): string =>
    new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  return (
    <div className="brief-overlay" onClick={onClose}>
      <div className="brief-box errands-box" onClick={(e) => e.stopPropagation()} data-testid="routines-sheet">
        <div className="brief-title errands-title">
          <Repeat size={15} aria-hidden /> {t('routines.title')}
        </div>
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
                {wallButtons(false)}
              </div>
            )}
            <LiveView open={routineWall !== null}>{routineWall && wallButtons(true)}</LiveView>
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

        {teaching && (
          <div className="routine-teach" data-testid="routine-teach">
            <div className="routine-teach-line">
              <Eye size={14} aria-hidden /> {t('routines.teachWatching')}
            </div>
            <div className="routine-teach-hint">{t('routines.teachPrivacy')}</div>
            <LiveView open>{teachButtons(true)}</LiveView>
            <div className="dialog-actions">{teachButtons(false)}</div>
          </div>
        )}

        {taught && (
          <div className="routine-teach" data-testid="routine-taught">
            <div className="routine-teach-line">{t('routines.taughtTitle', { n: taught.length })}</div>
            <ul className="errand-steps">
              {taught.map((step, i) => (
                <li key={i} className="errand-step passed">
                  {stepLine(step)}
                  <button
                    className="routine-step-remove"
                    aria-label={t('routines.removeStep')}
                    disabled={taught.length === 1}
                    onClick={() => setTaught((prev) => (prev ? prev.filter((_, x) => x !== i) : prev))}
                  >
                    <X size={11} aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
            <input
              className="routine-name"
              data-testid="routine-taught-name"
              placeholder={t('routines.namePlaceholder')}
              maxLength={60}
              value={taughtName}
              onChange={(e) => setTaughtName(e.target.value)}
            />
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setTaught(null)}>
                {t('routines.cancel')}
              </button>
              <button className="primary" data-testid="routine-taught-save" disabled={!taughtName.trim()} onClick={() => void keepTaught()}>
                {t('routines.save')}
              </button>
            </div>
          </div>
        )}

        {routines.length === 0 && !teaching && !taught ? (
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

        <div className="dialog-actions">
          <button className="primary" data-testid="routines-teach" disabled={teaching || busy} onClick={() => void teachStart()}>
            <Wand2 size={12} aria-hidden /> {t('routines.teach')}
          </button>
        </div>
      </div>
    </div>
  )
}
