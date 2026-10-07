import { ArrowLeft, ArrowRight, Check, LoaderCircle, MessageSquareText, Pencil, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { InterviewQuestionDto } from '../../../shared/types.js'
import { api } from '../api.js'

export const INTERVIEW_PENDING_KEY = 'engram.interviewPending'

type Reply = { picked: string[]; own: string }
export const replyText = (reply: Reply): string => [...reply.picked, reply.own.trim()].filter(Boolean).join('; ')

export function WorkInterview({ onClose, onSaved, onDraftChange }: { onClose(): void; onSaved(): void; onDraftChange(dirty: boolean): void }) {
  const [questions, setQuestions] = useState<InterviewQuestionDto[] | null>(null)
  const [replies, setReplies] = useState<Reply[]>([])
  const [at, setAt] = useState(0)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [busy, setBusy] = useState<'' | 'asking' | 'saving'>('')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const revision = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const done = useRef<HTMLButtonElement>(null)
  useEffect(() => () => { revision.current++; void api.interviewCancel().catch(() => undefined) }, [])
  useEffect(() => {
    if (!saved) { scroll.current?.scrollTo(0, 0); heading.current?.focus({ preventScroll: true }) }
  }, [at, questions, busy, saved])
  useEffect(() => { if (saved) done.current?.focus() }, [saved])
  useEffect(() => {
    if (!busy) return
    const started = performance.now()
    setElapsed(0)
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - started) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [busy])
  const answered = replies.filter((reply) => replyText(reply)).length
  useEffect(() => { onDraftChange(answered > 0 && !saved) }, [answered, saved, onDraftChange])
  const current = questions?.[at]
  const review = !!questions && at === questions.length
  const answerLength = replyText(replies[at] ?? { picked: [], own: '' }).length
  const tooLong = replies.some((reply) => replyText(reply).length > 1200)
  const move = (next: number) => { setError(''); setDirection(next < at ? 'back' : 'forward'); setAt(next) }
  const cancel = () => {
    const request = ++revision.current
    setBusy(''); setError('')
    void api.interviewCancel().catch(() => { if (request === revision.current) setError('Could not stop the request. Close this window to leave it.') })
  }
  const start = async () => {
    const request = ++revision.current
    setElapsed(0); setBusy('asking'); setError('')
    try {
      const next = await api.interviewQuestions()
      if (request !== revision.current) return
      if (!next.length) { setQuestions(null); setError('No questions yet. You can try again later in Settings.'); return }
      setQuestions(next); setReplies(next.map(() => ({ picked: [], own: '' }))); setDirection('forward'); setAt(0)
    } catch { if (request === revision.current) setError('Could not prepare questions. Check your AI connection and try again.') }
    finally { if (request === revision.current) setBusy('') }
  }
  const update = (change: (reply: Reply) => Reply) => setReplies((all) => all.map((reply, i) => i === at ? change(reply) : reply))
  const save = async () => {
    if (!questions || !answered || tooLong || busy) return
    const request = ++revision.current
    setElapsed(0); setBusy('saving'); setError('')
    try {
      const result = await api.interviewSave(questions.map((one, i) => ({ question: one.question, answer: replyText(replies[i] ?? { picked: [], own: '' }) })))
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
    <header className="interview-topbar">
      {questions && !saved && !busy && <div className="interview-progress" data-testid="interview-progress"><span>{review ? 'Review' : `${at + 1} / ${questions.length}`}</span><progress aria-label="Interview progress" max={questions.length} value={review ? questions.length : at + 1} /></div>}
      <button type="button" className="dialog-close" aria-label="Close work interview" onClick={onClose}><X size={16} strokeWidth={1.8} /></button>
    </header>
    {saved ? <div className="interview-scroll" data-testid="interview-scroll"><div className="interview-intro interview-success">
      <span className="interview-mark" aria-hidden><Check size={24} /></span><h3>Saved</h3>
      <p>Your preferences are ready for your next task.</p>
      <button ref={done} type="button" className="primary" data-testid="interview-done" onClick={onClose}>Done</button>
    </div></div> : busy ? <div className="interview-scroll" data-testid="interview-scroll">
      <div className="interview-intro interview-wait" data-testid="interview-wait">
        <span className="interview-mark" aria-hidden><LoaderCircle size={24} className="computer-spinner" /></span>
        <div role="status"><h3 ref={heading} tabIndex={-1}>{busy === 'saving' ? 'Saving your preferences…' : 'Preparing questions…'}</h3><p>{elapsed >= 20 ? 'Still waiting for your AI. You can cancel and retry.' : 'This can take a minute or more.'}</p></div>
        <span className="interview-elapsed" role="timer" aria-live="off">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</span>
        <button type="button" className="secondary" onClick={cancel}>Cancel</button>
      </div>
    </div> : !questions ? <div className="interview-scroll" data-testid="interview-scroll">
      <div className="interview-intro">
        <span className="interview-mark" aria-hidden><MessageSquareText size={22} /></span>
        <h3>Your way of working</h3>
        <p>A few optional questions. Skip any you like.</p>
        <p className="interview-privacy">Your AI sees file and site names and your work guide, not file contents. Task replies can update your preferences.</p>
        <div className="interview-intro-actions"><button type="button" className="primary" data-testid="interview-start" onClick={() => void start()}>Get started<ArrowRight size={15} aria-hidden /></button><button type="button" className="interview-skip" data-testid="interview-later" onClick={onClose}>Not now</button></div>
      </div>
      {error && <p className="computer-error" role="alert">{error}</p>}
    </div> : <form onSubmit={(event) => { event.preventDefault(); if (review) void save(); else if (answerLength <= 1200) move(at + 1) }}>
      <div ref={scroll} className="interview-scroll" data-testid="interview-scroll">
        <div key={at} className="interview-step" data-direction={direction}>
          {current && <fieldset className="interview-question" disabled={!!busy} data-testid={`interview-question-${at}`}>
            <legend><h3 ref={heading} tabIndex={-1}>{current.question}</h3></legend>
            <div className="interview-options">{current.options.map((option) => <label key={option} className="interview-option">
              <span>{option}</span><input type="checkbox" checked={replies[at]?.picked.includes(option) ?? false} onChange={(event) => update((reply) => ({ ...reply, picked: event.target.checked ? [...reply.picked, option] : reply.picked.filter((one) => one !== option) }))} />
            </label>)}</div>
            <textarea className="interview-own" rows={2} maxLength={1200} aria-label="Your answer" data-testid={`interview-answer-${at}`} value={replies[at]?.own ?? ''} placeholder={current.options.length ? 'Add your own…' : 'Your answer…'} onChange={(event) => update((reply) => ({ ...reply, own: event.target.value }))} />
            {answerLength > 1200 && <p className="computer-error" role="alert">Shorten this answer by {answerLength - 1200} characters, including selected choices.</p>}
          </fieldset>}
          {review && <div className="interview-review">
            <h3 ref={heading} tabIndex={-1}>Does this sound like you?</h3>
            {questions.map((one, i) => <button key={i} type="button" disabled={!!busy} className="interview-review-answer" onClick={() => move(i)} aria-label={`Edit answer ${i + 1}`}><span><strong>{one.question}</strong><span>{replyText(replies[i] ?? { picked: [], own: '' }) || 'Skipped'}</span></span><Pencil size={14} aria-hidden /></button>)}
          </div>}
        </div>
        {error && <p className="computer-error" role="alert">{error}</p>}
      </div>
      <div className="interview-actions">
        <button type="button" className="secondary" disabled={at === 0 || !!busy} onClick={() => move(at - 1)}><ArrowLeft size={14} aria-hidden />Back</button>
        <div>{!review && <button type="button" className="interview-skip" onClick={() => { update(() => ({ picked: [], own: '' })); move(at + 1) }}>Skip</button>}
          <button type="submit" className="primary" data-testid={review ? 'interview-save' : 'interview-next'} disabled={review ? !answered || tooLong : answerLength > 1200}>{review ? 'Save answers' : at === questions.length - 1 ? 'Review answers' : 'Continue'}{!review && <ArrowRight size={14} aria-hidden />}</button>
        </div>
      </div>
    </form>}
  </div>
}

export function WorkInterviewDialog({ onClose }: { onClose(): void }) {
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
    else dialog.current?.querySelector<HTMLButtonElement | HTMLHeadingElement>('[data-testid="interview-done"], .interview-step h3')?.focus({ preventScroll: true })
  }, [leaving])
  const dismiss = () => { if (dirty) setLeaving(true); else onClose() }
  return <dialog ref={dialog} className="interview-dialog" aria-label="How you work" data-testid="interview-dialog" onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }} onCancel={(event) => { event.preventDefault(); if (leaving) setLeaving(false); else dismiss() }}>
    <div className="interview-dialog-body" hidden={leaving}><WorkInterview onDraftChange={setDirty} onSaved={() => setLeaving(false)} onClose={dismiss} /></div>
    {leaving && <div className="interview-leave"><h3>Leave without saving?</h3><p>Your unsaved answers will be discarded.</p><div className="interview-actions"><button type="button" className="secondary" onClick={onClose}>Discard answers</button><button ref={keep} type="button" className="primary" onClick={() => setLeaving(false)}>Keep answering</button></div></div>}
  </dialog>
}
