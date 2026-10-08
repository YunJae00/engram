import { ArrowLeft, ArrowRight, Check, LoaderCircle, MessageSquareText, Pencil, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { EngramEvent, InterviewQuestionDto } from '../../../shared/types.js'
import { api } from '../api.js'

export const INTERVIEW_PENDING_KEY = 'engram.interviewPending'

type Reply = { picked: string[]; own: string; notMine?: boolean }
type PreparationProgress = Extract<EngramEvent, { type: 'interview:progress' }>
export const replyText = (reply: Reply): string => [...reply.picked, reply.own.trim()].filter(Boolean).join('; ')

export function WorkInterview({ onClose, onSaved, onDraftChange, autoStart = false }: { onClose(): void; onSaved(): void; onDraftChange(dirty: boolean): void; autoStart?: boolean }) {
  const [questions, setQuestions] = useState<InterviewQuestionDto[] | null>(null)
  const [replies, setReplies] = useState<Reply[]>([])
  const [at, setAt] = useState(0)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [busy, setBusy] = useState<'' | 'asking' | 'saving'>(autoStart ? 'asking' : '')
  const [progress, setProgress] = useState<PreparationProgress | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const finished = saved || questions?.length === 0
  const intro = !questions && !busy && !saved
  const revision = useRef(0)
  const requestId = useRef<string | null>(null)
  const latestProgress = useRef<PreparationProgress | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const done = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const off = api.onEvent(event => {
      if (event.type !== 'interview:progress' || event.requestId !== requestId.current) return
      latestProgress.current = event; setProgress(event)
    })
    return () => { off(); revision.current++; requestId.current = null; void api.interviewCancel().catch(() => undefined) }
  }, [])
  useEffect(() => {
    if (!finished) { scroll.current?.scrollTo(0, 0); heading.current?.focus({ preventScroll: true }) }
  }, [at, questions, busy, finished])
  useEffect(() => { if (finished) done.current?.focus() }, [finished])
  useEffect(() => {
    if (!busy) return
    const started = performance.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [busy])
  const answered = replies.filter((reply) => reply.notMine || replyText(reply)).length
  useEffect(() => { onDraftChange(answered > 0 && !saved) }, [answered, saved, onDraftChange])
  const current = questions?.[at]
  const review = !!questions && at === questions.length
  const answerLength = replyText(replies[at] ?? { picked: [], own: '' }).length
  const tooLong = replies.some((reply) => replyText(reply).length > 1200)
  const move = (next: number) => { setError(''); setDirection(next < at ? 'back' : 'forward'); setAt(next) }
  const cancel = () => {
    const request = ++revision.current
    requestId.current = null
    setBusy(''); setError('')
    void api.interviewCancel().catch(() => { if (request === revision.current) setError('Could not stop the request. Close this window to leave it.') })
  }
  const start = useCallback(async () => {
    const request = ++revision.current
    const id = crypto.randomUUID()
    requestId.current = id; latestProgress.current = null; setProgress(null)
    setElapsed(0); setBusy('asking'); setError('')
    try {
      const next = await api.interviewQuestions({ requestId: id })
      if (request !== revision.current) return
      setQuestions(next); setReplies(next.map(() => ({ picked: [], own: '' }))); setDirection('forward'); setAt(0)
      if (!next.length) {
        try { localStorage.removeItem(INTERVIEW_PENDING_KEY) } catch { /* This completed prompt can still be dismissed. */ }
      }
    } catch {
      if (request === revision.current) {
        const phase = (latestProgress.current as PreparationProgress | null)?.phase
        setError(phase === 'mapping' ? 'Could not finish mapping your work places. Retry, or finish setup later in Settings.' : phase === 'filing' ? 'Cosmos preparation paused before it finished. Retry, or finish setup later in Settings.' : 'Could not prepare questions. Check your AI connection and try again.')
      }
    } finally { if (request === revision.current) { requestId.current = null; setBusy('') } }
  }, [])
  useEffect(() => {
    if (!autoStart) return
    const timer = window.setTimeout(() => void start(), 0)
    return () => window.clearTimeout(timer)
  }, [autoStart, start])
  const startNow = () => { cancel(); onClose() }
  const update = (change: (reply: Reply) => Reply) => setReplies((all) => all.map((reply, i) => i === at ? change(reply) : reply))
  const save = async () => {
    if (!questions || !answered || tooLong || busy) return
    const request = ++revision.current
    setElapsed(0); setBusy('saving'); setError('')
    try {
      const result = await api.interviewSave(questions.map((one, i) => ({ question: one.question, answer: replyText(replies[i] ?? { picked: [], own: '' }), ...(one.source ? { source: one.source } : {}), ...(replies[i]?.notMine ? { rejected: true } : {}) })))
      if (request !== revision.current) return
      if (result.saved) {
        try { localStorage.removeItem(INTERVIEW_PENDING_KEY) } catch { /* The work guide is saved independently of browser storage. */ }
        setSaved(true); onDraftChange(false); onSaved()
      }
      else setError('No answers were saved. Add an answer or try again.')
    } catch { if (request === revision.current) setError('Could not save your answers. They are still here; please try again.') }
    finally { if (request === revision.current) setBusy('') }
  }
  return <div className="work-interview" data-testid="work-interview" aria-busy={!!busy}>
    <header className={`interview-topbar${intro ? ' interview-topbar-intro' : ''}`}>
      {intro && <><span className="interview-mark" aria-hidden><MessageSquareText size={20} /></span><h3 ref={heading} tabIndex={-1} data-testid="interview-intro-heading">Your way of working</h3></>}
      {questions && !finished && !busy && <div className="interview-progress" data-testid="interview-progress"><span>{review ? 'Review' : `${at + 1} / ${questions.length}`}</span><progress aria-label="Interview progress" max={questions.length} value={review ? questions.length : at + 1} /></div>}
      <button type="button" className="dialog-close" aria-label="Close work interview" onClick={onClose}><X size={16} strokeWidth={1.8} /></button>
    </header>
    {finished ? <div className="interview-scroll" data-testid="interview-scroll"><div className="interview-intro interview-success">
      <span className="interview-mark" aria-hidden>{saved ? <Check size={24} /> : <MessageSquareText size={24} />}</span><h3>{saved ? 'Saved' : 'Nothing to ask yet'}</h3>
      <p>{saved ? 'Your preferences are ready for your next task.' : 'You can start working and come back later.'}</p>
      <button ref={done} type="button" className="primary" data-testid="interview-done" onClick={onClose}>Done</button>
    </div></div> : busy ? <div className="interview-scroll" data-testid="interview-scroll">
      <div className="interview-intro interview-wait" data-testid="interview-wait">
        <span className="interview-mark" aria-hidden><LoaderCircle size={24} className="computer-spinner" /></span>
        <div role="status"><h3 ref={heading} tabIndex={-1} data-testid="interview-phase">{busy === 'saving' ? 'Saving your preferences…' : progress?.phase === 'mapping' ? 'Finding your work places…' : progress?.phase === 'filing' ? progress.stage === 'capture' ? 'Filing your first captures…' : progress.stage === 'organize' ? 'Organizing Cosmos…' : 'Preparing Cosmos…' : progress?.phase === 'questions' ? 'Preparing questions…' : 'Starting setup…'}</h3>
          {busy === 'asking' && progress?.phase === 'filing' && progress.completed !== undefined && progress.total !== undefined && <p className="interview-count" data-testid="interview-file-count">{progress.completed} / {progress.total} completed</p>}
          <p>{busy === 'saving' ? elapsed >= 20 ? 'Still waiting for your AI. You can cancel and retry.' : 'This can take a minute or more.' : elapsed >= 20 ? 'Still working. You can start now and return in Settings.' : 'Preparing Cosmos before your questions. You can start now.'}</p></div>
        <span className="interview-elapsed" role="timer" aria-live="off">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
        <div className="interview-intro-actions"><button type="button" className={busy === 'asking' ? 'interview-skip' : 'secondary'} onClick={cancel}>Cancel</button>{busy === 'asking' && <button type="button" className="primary" data-testid="interview-start-now" onClick={startNow}>Start now<ArrowRight size={15} aria-hidden /></button>}</div>
      </div>
    </div> : !questions ? <div className="interview-scroll" data-testid="interview-scroll">
      <div className="interview-intro">
        <p>{error ? 'You can continue without finishing setup.' : 'Prepare Cosmos, then answer a few optional questions.'}</p>
        <details className="interview-privacy"><summary>What your AI sees</summary><p>Selected Cosmos note excerpts, site names and visit patterns, completed task requests, and your work guide. No new scan of your original documents. Task replies can update your preferences.</p></details>
        {error && <p className="computer-error" role="alert">{error}</p>}
        <div className="interview-intro-actions"><button type="button" className="primary" data-testid="interview-start" onClick={() => void start()}>{error ? 'Retry' : 'Get started'}<ArrowRight size={15} aria-hidden /></button><button type="button" className="interview-skip" data-testid="interview-later" onClick={onClose}>{error ? 'Start now' : 'Not now'}</button></div>
      </div>
    </div> : <form onSubmit={(event) => { event.preventDefault(); if (review) void save(); else if (answerLength <= 1200) move(at + 1) }}>
      <div ref={scroll} className="interview-scroll" data-testid="interview-scroll">
        <div key={at} className="interview-step" data-direction={direction}>
          {current && <fieldset className="interview-question" disabled={!!busy} data-testid={`interview-question-${at}`}>
            <legend><h3 ref={heading} tabIndex={-1}>{current.question}</h3></legend>
            <div className="interview-options">{current.options.map((option) => <label key={option} className="interview-option">
              <span>{option}</span><input type="checkbox" checked={replies[at]?.picked.includes(option) ?? false} onChange={(event) => update((reply) => ({ ...reply, notMine: false, picked: event.target.checked ? [...reply.picked, option] : reply.picked.filter((one) => one !== option) }))} />
            </label>)}</div>
            <textarea className="interview-own" rows={2} maxLength={1200} aria-label="Your answer" data-testid={`interview-answer-${at}`} value={replies[at]?.own ?? ''} placeholder={current.options.length ? 'Add your own…' : 'Your answer…'} onChange={(event) => update((reply) => ({ ...reply, notMine: false, own: event.target.value }))} />
            {answerLength > 1200 && <p className="computer-error" role="alert">Shorten this answer by {answerLength - 1200} characters, including selected choices.</p>}
          </fieldset>}
          {review && <div className="interview-review">
            <h3 ref={heading} tabIndex={-1}>Does this sound like you?</h3>
            {questions.map((one, i) => <button key={i} type="button" disabled={!!busy} className="interview-review-answer" onClick={() => move(i)} aria-label={`Edit answer ${i + 1}`}><span><strong>{one.question}</strong><span>{replies[i]?.notMine ? 'Not my work' : replyText(replies[i] ?? { picked: [], own: '' }) || 'Skipped'}</span></span><Pencil size={14} aria-hidden /></button>)}
          </div>}
        </div>
        {error && <p className="computer-error" role="alert">{error}</p>}
      </div>
      <div className="interview-actions">
        <div><button type="button" className="secondary" disabled={at === 0 || !!busy} onClick={() => move(at - 1)}><ArrowLeft size={14} aria-hidden />Back</button>
          {!review && <button type="button" className="interview-skip" data-testid="interview-not-mine" aria-pressed={!!replies[at]?.notMine} onClick={() => { update(() => ({ picked: [], own: '', notMine: true })); move(at + 1) }}>Not my work</button>}</div>
        <div>{!review && <button type="button" className="interview-skip" onClick={() => { update(() => ({ picked: [], own: '' })); move(at + 1) }}>Skip</button>}
          <button type="submit" className="primary" data-testid={review ? 'interview-save' : 'interview-next'} disabled={review ? !answered || tooLong : answerLength > 1200}>{review ? 'Save answers' : at === questions.length - 1 ? 'Review answers' : 'Continue'}{!review && <ArrowRight size={14} aria-hidden />}</button>
        </div>
      </div>
    </form>}
  </div>
}

export function WorkInterviewDialog({ onClose, autoStart = false }: { onClose(): void; autoStart?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [dirty, setDirty] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const element = dialog.current
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    element?.showModal()
    return () => { element?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    if (leaving) keep.current?.focus()
    else dialog.current?.querySelector<HTMLButtonElement | HTMLHeadingElement>('[data-testid="interview-done"], [data-testid="interview-intro-heading"], .interview-step h3')?.focus({ preventScroll: true })
  }, [leaving])
  const dismiss = () => { if (dirty) setLeaving(true); else onClose() }
  return <dialog ref={dialog} className="interview-dialog" aria-label="How you work" data-testid="interview-dialog" onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }} onCancel={(event) => { event.preventDefault(); if (leaving) setLeaving(false); else dismiss() }}>
    <div className="interview-dialog-body" hidden={leaving}><WorkInterview autoStart={autoStart} onDraftChange={setDirty} onSaved={() => setLeaving(false)} onClose={dismiss} /></div>
    {leaving && <div className="interview-leave"><h3>Leave without saving?</h3><p>Your unsaved answers will be discarded.</p><div className="interview-actions"><button type="button" className="secondary" onClick={onClose}>Discard answers</button><button ref={keep} type="button" className="primary" onClick={() => setLeaving(false)}>Keep answering</button></div></div>}
  </dialog>
}
