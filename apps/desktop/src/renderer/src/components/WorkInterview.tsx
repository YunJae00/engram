import { ArrowLeft, ArrowRight, Check, LoaderCircle, MessageSquareText, Pencil } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { InterviewQuestionDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { DialogHeader } from './DialogHeader.js'

export const INTERVIEW_PENDING_KEY = 'engram.interviewPending'

type Reply = { picked: string[]; own: string }
export const replyText = (reply: Reply): string => [...reply.picked, reply.own.trim()].filter(Boolean).join('; ')

export function WorkInterview({ onDone, onDraftChange }: { onDone?: () => void; onDraftChange?: (dirty: boolean) => void }) {
  const [questions, setQuestions] = useState<InterviewQuestionDto[] | null>(null)
  const [replies, setReplies] = useState<Reply[]>([])
  const [at, setAt] = useState(0)
  const [busy, setBusy] = useState<'' | 'asking' | 'saving'>('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const revision = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => () => { revision.current++; void api.interviewCancel().catch(() => undefined) }, [])
  useEffect(() => { if (questions) heading.current?.focus() }, [at, questions])
  const answered = replies.filter((reply) => replyText(reply)).length
  useEffect(() => { onDraftChange?.(answered > 0 && !saved) }, [answered, saved, onDraftChange])
  const current = questions?.[at]
  const review = !!questions && at === questions.length
  const answerLength = replyText(replies[at] ?? { picked: [], own: '' }).length
  const tooLong = replies.some((reply) => replyText(reply).length > 1200)
  const cancel = () => { revision.current++; setBusy(''); void api.interviewCancel().catch(() => setError('Could not stop the request. Close this window to leave it.')) }
  const start = async () => {
    const request = ++revision.current
    setBusy('asking'); setError(''); setSaved(false)
    try {
      const next = await api.interviewQuestions()
      if (request !== revision.current) return
      if (!next.length) { setQuestions(null); setError('No questions yet. You can try again later in Settings.'); return }
      setQuestions(next); setReplies(next.map(() => ({ picked: [], own: '' }))); setAt(0)
    } catch { if (request === revision.current) setError('Could not prepare questions. Check your AI connection and try again.') }
    finally { if (request === revision.current) setBusy('') }
  }
  const update = (change: (reply: Reply) => Reply) => setReplies((all) => all.map((reply, i) => i === at ? change(reply) : reply))
  const save = async () => {
    if (!questions || !answered || tooLong || busy) return
    const request = ++revision.current
    setBusy('saving'); setError('')
    try {
      const result = await api.interviewSave(questions.map((one, i) => ({ question: one.question, answer: replyText(replies[i] ?? { picked: [], own: '' }) })))
      if (request !== revision.current) return
      if (result.saved) { setSaved(true); setQuestions(null); onDone?.() }
      else setError('No answers were saved. Add an answer or try again.')
    } catch { if (request === revision.current) setError('Could not save your answers. They are still here; please try again.') }
    finally { if (request === revision.current) setBusy('') }
  }
  return <div className="work-interview" data-testid="work-interview" aria-busy={!!busy}>
    {!questions && <div className="interview-intro">
      <span className="interview-mark" aria-hidden>{saved ? <Check size={22} /> : <MessageSquareText size={22} />}</span>
      <h3>{saved ? 'A little more like you.' : 'Make Engram feel like your coworker.'}</h3>
      <p>{saved ? 'Your answers are saved in “How I work”. You can edit that note in Cosmos.' : 'A few optional questions help Engram follow your preferences. Answer what matters; skip the rest.'}</p>
      {!saved && <p className="interview-privacy">Your AI uses recent file and work-site names, plus your existing work guide. Your documents stay unopened. The saved guide can learn recurring preferences from answers you give during tasks.</p>}
      {busy === 'asking' ? <div className="interview-wait" role="status"><LoaderCircle size={18} className="computer-spinner" aria-hidden /><span>Preparing questions for you…</span><button type="button" className="secondary" onClick={cancel}>Cancel</button></div> : <button type="button" className="primary" data-testid="interview-start" onClick={() => void start()}>{saved ? 'Ask more questions' : 'Get started'}<ArrowRight size={15} aria-hidden /></button>}
    </div>}
    {questions && <form onSubmit={(event) => { event.preventDefault(); if (review) void save(); else if (answerLength <= 1200) setAt(at + 1) }}>
      <div className="interview-progress"><span>{review ? 'Review your answers' : `Question ${at + 1} of ${questions.length}`}</span><span>{answered} answered</span></div>
      <progress aria-label="Interview progress" max={questions.length} value={review ? questions.length : at} />
      {current && <fieldset className="interview-question" disabled={!!busy} data-testid={`interview-question-${at}`}>
        <legend><h3 ref={heading} tabIndex={-1}>{current.question}</h3></legend>
        {current.basis && <p className="interview-basis">Based on {current.basis}</p>}
        {!!current.options.length && <p className="interview-hint">Choose any that fit.</p>}
        <div className="interview-options">{current.options.map((option) => <label key={option} className="interview-option">
          <input type="checkbox" checked={replies[at]?.picked.includes(option) ?? false} onChange={(event) => update((reply) => ({ ...reply, picked: event.target.checked ? [...reply.picked, option] : reply.picked.filter((one) => one !== option) }))} />
          <span>{option}</span><Check size={15} className="interview-option-check" aria-hidden />
        </label>)}</div>
        <label className="interview-own">{current.options.length ? 'In your own words (optional)' : 'Your answer (optional)'}<textarea rows={2} maxLength={1200} data-testid={`interview-answer-${at}`} value={replies[at]?.own ?? ''} placeholder="Add anything that matters to you…" onChange={(event) => update((reply) => ({ ...reply, own: event.target.value }))} /></label>
        {answerLength > 1200 && <p className="computer-error" role="alert">Shorten this answer by {answerLength - 1200} characters, including selected choices.</p>}
      </fieldset>}
      {review && <div className="interview-review">
        <h3 ref={heading} tabIndex={-1}>Does this sound like you?</h3>
        <p>Only your answers will be saved. You can edit the note later in Cosmos.</p>
        {questions.map((one, i) => <button key={i} type="button" disabled={!!busy} className="interview-review-answer" onClick={() => { setError(''); setAt(i) }} aria-label={`Edit answer ${i + 1}`}><span><strong>{one.question}</strong><span>{replyText(replies[i] ?? { picked: [], own: '' }) || 'Skipped'}</span></span><Pencil size={14} aria-hidden /></button>)}
      </div>}
      {error && <p className="computer-error" role="alert">{error}</p>}
      <div className="interview-actions">
        <button type="button" className="secondary" disabled={at === 0 || !!busy} onClick={() => { setError(''); setAt(at - 1) }}><ArrowLeft size={14} aria-hidden />Back</button>
        <div>{!review && <button type="button" className="interview-skip" onClick={() => { update(() => ({ picked: [], own: '' })); setAt(at + 1) }}>Skip</button>}
          {busy === 'saving' && <button type="button" className="secondary" onClick={cancel}>Cancel</button>}
          <button type="submit" className="primary" data-testid={review ? 'interview-save' : 'interview-next'} disabled={!!busy || (review ? !answered || tooLong : answerLength > 1200)}>{busy === 'saving' ? <><LoaderCircle size={15} className="computer-spinner" aria-hidden />Saving…</> : review ? 'Save answers' : at === questions.length - 1 ? 'Review answers' : 'Continue'}{!review && <ArrowRight size={14} aria-hidden />}</button>
        </div>
      </div>
    </form>}
    {!questions && error && <p className="computer-error" role="alert">{error}</p>}
  </div>
}

export function WorkInterviewDialog({ onClose, onSaved }: { onClose(): void; onSaved?: () => void }) {
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
  useEffect(() => { if (leaving) keep.current?.focus() }, [leaving])
  const dismiss = () => { if (dirty) setLeaving(true); else onClose() }
  return <dialog ref={dialog} className="interview-dialog" aria-label="How you work" data-testid="interview-dialog" onKeyDown={(event) => { if (event.key === 'Escape') event.stopPropagation() }} onCancel={(event) => { event.preventDefault(); if (leaving) setLeaving(false); else dismiss() }}>
    <DialogHeader closeLabel="Close work interview" onClose={dismiss}>How you work</DialogHeader>
    <div className="interview-dialog-body" hidden={leaving}><WorkInterview onDraftChange={setDirty} onDone={() => { onSaved?.(); onClose() }} /></div>
    {leaving && <div className="interview-dialog-body interview-leave"><h3>Leave without saving?</h3><p>Your answers will be discarded.</p><div className="interview-actions"><button type="button" className="secondary" onClick={onClose}>Discard answers</button><button ref={keep} type="button" className="primary" onClick={() => setLeaving(false)}>Keep answering</button></div></div>}
    <div className="interview-dialog-footer" hidden={leaving}><button type="button" data-testid="interview-later" onClick={dismiss}>Not now</button><span>Always available in Settings → Memory &amp; data</span></div>
  </dialog>
}
