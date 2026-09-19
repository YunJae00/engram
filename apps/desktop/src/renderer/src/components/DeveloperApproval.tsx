import { lazy, Suspense, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { DevApproval } from '../../../shared/developers.js'
import { api } from '../api.js'

const DiffView = lazy(() => import('../editor/DiffView.js').then(module => ({ default: module.DiffView })))
export function DeveloperApproval({ sessionId, approval }: { sessionId: string; approval: DevApproval }) {
  const [answers, setAnswers] = useState<Record<string, string[]>>({}), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [remember, setRemember] = useState(false)
  const respond = async (decision: 'allow' | 'deny') => {
    setBusy(true); setError('')
    try { await api.devRespond(sessionId, approval.id, { decision, answers, remember }) }
    catch (error) { setError((error as Error).message); setBusy(false) }
  }
  return <section className="dev-approval" aria-label={approval.title}>
    <h3><ShieldCheck size={17} />{approval.title}</h3>
    {approval.detail && <details open><summary>Review details</summary><pre>{approval.detail}</pre></details>}
    {approval.changes?.map(change => <details key={change.path} open><summary>{change.path}</summary><Suspense fallback={<p>Loading changes…</p>}><DiffView left={change.before} right={change.after} leftLabel="Before" rightLabel="Proposed" /></Suspense></details>)}
    {approval.questions?.map(question => <fieldset key={question.id}><legend>{question.text}</legend>
      {question.options.map(option => <label key={option}><input type={question.multiple ? 'checkbox' : 'radio'} name={`${approval.id}-${question.id}`} checked={answers[question.id]?.includes(option) ?? false} onChange={event => setAnswers(current => ({ ...current, [question.id]: question.multiple ? event.target.checked ? [...(current[question.id] ?? []), option] : (current[question.id] ?? []).filter(value => value !== option) : [option] }))} />{option}</label>)}
      <input aria-label={`Your answer: ${question.text}`} placeholder="Or write your answer…" value={answers[question.id]?.filter(value => !question.options.includes(value)).join(', ') ?? ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value ? [event.target.value] : [] }))} />
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    {approval.remember && <label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />Remember for this exact edit and starting content</label>}
    <div className="dev-actions"><button className="secondary" disabled={busy} onClick={() => void respond('deny')}>{approval.kind === 'question' ? 'Cancel' : 'Deny'}</button><button className="primary" disabled={busy || !!approval.questions?.some(question => !answers[question.id]?.some(answer => answer.trim()))} onClick={() => void respond('allow')}>{busy ? 'Sending…' : approval.kind === 'question' ? 'Continue' : 'Allow once'}</button></div>
  </section>
}
