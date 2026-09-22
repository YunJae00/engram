import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { LoaderCircle, Repeat, X } from 'lucide-react'
import type { RoutineLearningDto } from '../../../shared/types.js'
import { api, apiErrorText } from '../api.js'

export function RoutineSkillHint({ value, select }: { value: string; select(): void }) {
  const query = value.trim().toLowerCase()
  return query.startsWith('/') && '/routine'.startsWith(query) ? <button className="routine-skill-hint" type="button" onClick={select}><Repeat size={15} aria-hidden /><span><strong>/routine</strong> · Learn a routine from this chat</span></button> : null
}

export function RoutineLearning({ botId, working }: { botId: string; working: boolean }) {
  const [state, setState] = useState<RoutineLearningDto | null>(null), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let alive = true, revision = 0
    const load = () => { const at = ++revision; void api.routineLearning(botId).then(next => { if (alive && at === revision) setState(next) }).catch(cause => { if (alive && at === revision) setError(apiErrorText(String(cause))) }) }
    const off = api.onEvent(event => { if (event.type === 'routine:learning' && event.botId === botId) { if (event.error) setError(event.error); load() } })
    load()
    return () => { alive = false; off() }
  }, [botId])
  const act = async (action: 'finish' | 'discard' | 'save', input?: { id: string; name: string; goal: string }) => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const next = await api.routineLearningAction(botId, action, input)
      setState(next)
      if (!next) setOpen(false)
    } catch (cause) { setError(apiErrorText(String(cause))) }
    finally { setBusy(false) }
  }
  if (!state) return error ? <p className="routine-learning-error" role="alert">{error}</p> : null
  return <>
    <div className="routine-learning-bar" data-testid="routine-learning-bar" role="status">
      <Repeat size={14} aria-hidden /><span>{state.phase === 'recording' ? 'Learning routine' : 'Routine draft'} · {state.turns} {state.turns === 1 ? 'turn' : 'turns'}</span>
      <button type="button" disabled={working || busy || state.preparing} onClick={() => { setOpen(true); if (state.phase === 'recording') void act('finish') }}>{busy || state.preparing ? <LoaderCircle className="spin" size={14} aria-label="Preparing routine" /> : state.phase === 'recording' ? 'Finish' : 'Review'}</button>
      <button type="button" aria-label="Discard routine draft" disabled={busy || state.preparing} onClick={() => void act('discard')}><X size={14} aria-hidden /></button>
    </div>
    {error && !open && <p className="routine-learning-error" role="alert">{error}</p>}
    <RoutineDraft open={open} state={state} busy={busy || state.preparing} error={error} close={() => setOpen(false)} prepare={() => void act('finish')} save={(name, goal) => void act('save', { id: state.id, name, goal })} />
  </>
}

function RoutineDraft({ open, state, busy, error, close, prepare, save }: { open: boolean; state: RoutineLearningDto; busy: boolean; error: string; close(): void; prepare(): void; save(name: string, goal: string): void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState(state.draft.name), [goal, setGoal] = useState(state.draft.goal)
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  useEffect(() => { setName(state.draft.name); setGoal(state.draft.goal) }, [state.draft.name, state.draft.goal])
  return createPortal(<dialog ref={dialog} className="routine-draft-dialog" aria-label="Review routine" onCancel={event => { event.preventDefault(); close() }}>
    <header><h2><Repeat size={20} aria-hidden />Review routine</h2><button type="button" aria-label="Close routine review" onClick={close}><X size={17} aria-hidden /></button></header>
    <p className="setting-hint">Only this chat, since you started the skill. Review before saving; nothing runs or gets scheduled.</p>
    {busy && <p className="dev-working" role="status"><LoaderCircle size={15} className="spin" aria-hidden />Preparing your routine…</p>}
    {state.limited && <p role="status">Collection stopped at its size limit. Check the instructions for missing steps.</p>}
    {state.incomplete > 0 && <p role="status">{state.incomplete} turns were incomplete. Their actions are not saved as a verified method.</p>}
    <label>Name<input value={name} maxLength={60} disabled={busy} onChange={event => setName(event.target.value)} /></label>
    <label>Instructions<textarea aria-label="Instructions" value={goal} maxLength={4000} disabled={busy} onChange={event => setGoal(event.target.value)} placeholder="Where to start, inputs to ask for, work to perform, and how to verify the result." /></label>
    {(state.urls.length > 0 || state.method.length > 0) && <details><summary>Included navigation hints</summary>{state.urls.map(url => <p key={url}>{url}</p>)}<ol>{state.method.map((line, index) => <li key={index}>{line}</li>)}</ol></details>}
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" className="secondary" disabled={busy || !state.turns} onClick={prepare}>Organize again</button><button type="button" className="primary" disabled={busy || state.phase !== 'review' || !name.trim() || !goal.trim()} onClick={() => save(name, goal)}>Save routine</button></footer>
  </dialog>, document.body)
}
