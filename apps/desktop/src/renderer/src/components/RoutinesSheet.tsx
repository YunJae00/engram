import { AlertTriangle, Eye, Play, Plus, Repeat, Square, Wand2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { RoutineBlockDto, RoutineDto, RoutineStepDto } from '../../../shared/types.js'
import { stepLine } from '../lib/routineSteps.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'

// Routines are the repetition with the thinking already done: the pages and
// clicks a person walks every day, saved once, replayed with one press. The
// builder speaks in plain moves (open, click, type, read) so a non-developer
// can author one without ever seeing a selector — selectors arrive later,
// when a teach-mode records them; the visible words are enough to start.

interface DraftStep {
  kind: RoutineStepDto['kind']
  url: string
  target: string
  text: string
}

const EMPTY_STEP: DraftStep = { kind: 'open', url: '', target: '', text: '' }

function toStepDto(draft: DraftStep): RoutineStepDto {
  switch (draft.kind) {
    case 'open':
      return { kind: 'open', url: draft.url.trim() }
    case 'click':
      return { kind: 'click', target: { text: draft.target.trim() } }
    case 'type':
      return { kind: 'type', target: { text: draft.target.trim() }, text: draft.text }
    case 'read':
      return { kind: 'read' }
  }
}

function draftReady(draft: DraftStep): boolean {
  if (draft.kind === 'open') return draft.url.trim().length > 0
  if (draft.kind === 'click') return draft.target.trim().length > 0
  if (draft.kind === 'type') return draft.target.trim().length > 0 && draft.text.length > 0
  return true
}

export function RoutinesSheet({ onClose }: { onClose(): void }) {
  const { routine, routineWall, answerRoutineWall, startRoutine, errand, showToast, t } = useApp()
  const [routines, setRoutines] = useState<RoutineDto[]>([])
  const [building, setBuilding] = useState(false)
  const [name, setName] = useState('')
  const [drafts, setDrafts] = useState<DraftStep[]>([{ ...EMPTY_STEP }])
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  // A refused rerun is a question, asked right where it was answered.
  const [ask, setAsk] = useState<{ id: string; name: string; blocked: RoutineBlockDto } | null>(null)
  // Teach mode: the agent window is open and recording; when it ends, the
  // captured steps wait here under a name box until the person keeps them.
  const [teaching, setTeaching] = useState(false)
  const [taught, setTaught] = useState<RoutineStepDto[] | null>(null)
  const [taughtName, setTaughtName] = useState('')

  useEscape(onClose, true)

  const reload = () => void api.routinesList().then(setRoutines).catch(() => {})

  useEffect(() => {
    reload()
    return api.onEvent((event) => {
      // vault:changed too: a routine is a note now, so one appearing (sync,
      // another window, a fresh save) must show up without reopening.
      if (event.type === 'routine:logged' || event.type === 'vault:changed') reload()
    })
  }, [])

  const busy = routine.running || errand.running

  const save = async () => {
    const steps = drafts.map(toStepDto)
    try {
      await api.routineAdd({ name, steps })
      setBuilding(false)
      setName('')
      setDrafts([{ ...EMPTY_STEP }])
      reload()
    } catch (err) {
      showToast(err instanceof Error ? err.message.replace(/^.*Error: /, '') : String(err))
    }
  }

  const run = async (id: string, name: string, force = false) => {
    setAsk(null)
    const result = await startRoutine(id, name, force)
    if (result.blocked) setAsk({ id, name, blocked: result.blocked })
  }

  const teachStart = async () => {
    const started = await api.routineTeachStart()
    if (!started.ok) {
      showToast(started.error ?? t('routines.teachFailed'))
      return
    }
    setTaught(null)
    setTeaching(true)
  }

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

  const patchDraft = (index: number, patch: Partial<DraftStep>) =>
    setDrafts((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)))

  const when = (iso: string): string =>
    new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

  const canSave = name.trim().length > 0 && drafts.length > 0 && drafts.every(draftReady)

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
                <button className="errand-wall-done" data-testid="routine-wall-done" onClick={() => answerRoutineWall('resolved')}>
                  {t('routines.wallDone')}
                </button>
                <button className="errand-wall-skip" onClick={() => answerRoutineWall('skip')}>
                  {t('routines.wallStop')}
                </button>
              </div>
            )}
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
            <div className="dialog-actions">
              <button className="secondary" data-testid="routine-teach-cancel" onClick={() => void teachStop(false)}>
                {t('routines.cancel')}
              </button>
              <button className="secondary" data-testid="routine-teach-read" onClick={() => void api.routineTeachRead()}>
                {t('routines.teachRead')}
              </button>
              <button className="primary" data-testid="routine-teach-done" onClick={() => void teachStop(true)}>
                {t('routines.teachDone')}
              </button>
            </div>
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

        {routines.length === 0 && !building && !teaching && !taught ? (
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

        {building ? (
          <div className="routine-builder" data-testid="routine-builder">
            <input
              autoFocus
              className="routine-name"
              data-testid="routine-name"
              placeholder={t('routines.namePlaceholder')}
              maxLength={60}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {drafts.map((draft, i) => (
              <div key={i} className="routine-step-row" data-testid="routine-step-row">
                <select
                  className="routine-step-kind"
                  data-testid={`routine-step-kind-${i}`}
                  value={draft.kind}
                  onChange={(e) => patchDraft(i, { kind: e.target.value as DraftStep['kind'] })}
                >
                  <option value="open">{t('routines.stepOpen')}</option>
                  <option value="click">{t('routines.stepClick')}</option>
                  <option value="type">{t('routines.stepType')}</option>
                  <option value="read">{t('routines.stepRead')}</option>
                </select>
                {draft.kind === 'open' && (
                  <input
                    className="routine-step-input"
                    data-testid={`routine-step-url-${i}`}
                    placeholder={t('routines.stepUrl')}
                    value={draft.url}
                    onChange={(e) => patchDraft(i, { url: e.target.value })}
                  />
                )}
                {(draft.kind === 'click' || draft.kind === 'type') && (
                  <input
                    className="routine-step-input"
                    data-testid={`routine-step-target-${i}`}
                    placeholder={t('routines.stepTarget')}
                    maxLength={120}
                    value={draft.target}
                    onChange={(e) => patchDraft(i, { target: e.target.value })}
                  />
                )}
                {draft.kind === 'type' && (
                  <input
                    className="routine-step-input"
                    data-testid={`routine-step-text-${i}`}
                    placeholder={t('routines.stepText')}
                    maxLength={500}
                    value={draft.text}
                    onChange={(e) => patchDraft(i, { text: e.target.value })}
                  />
                )}
                {draft.kind === 'read' && <span className="routine-step-note">{t('routines.stepReadNote')}</span>}
                <button
                  className="routine-step-remove"
                  aria-label={t('routines.removeStep')}
                  disabled={drafts.length === 1}
                  onClick={() => setDrafts((prev) => prev.filter((_, x) => x !== i))}
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            ))}
            <button
              className="secondary routine-add-step"
              data-testid="routine-add-step"
              disabled={drafts.length >= 30}
              onClick={() => setDrafts((prev) => [...prev, { ...EMPTY_STEP }])}
            >
              <Plus size={12} aria-hidden /> {t('routines.addStep')}
            </button>
            <div className="dialog-actions">
              <button className="secondary" onClick={() => setBuilding(false)}>
                {t('routines.cancel')}
              </button>
              <button className="primary" data-testid="routine-save" disabled={!canSave} onClick={() => void save()}>
                {t('routines.save')}
              </button>
            </div>
          </div>
        ) : (
          <div className="dialog-actions">
            <button className="secondary" data-testid="routines-new" disabled={teaching} onClick={() => setBuilding(true)}>
              <Plus size={12} aria-hidden /> {t('routines.new')}
            </button>
            <button className="primary" data-testid="routines-teach" disabled={teaching || busy} onClick={() => void teachStart()}>
              <Wand2 size={12} aria-hidden /> {t('routines.teach')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
