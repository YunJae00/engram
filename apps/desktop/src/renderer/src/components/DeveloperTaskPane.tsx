import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowUp, Folder, GitBranch, LoaderCircle, Settings, Square, X } from 'lucide-react'
import type { DevGitState, DevItem, DevRepo, DevSession, DevState } from '../../../shared/developers.js'
import { api } from '../api.js'
import { ModelPicker, type ModelSelection } from './ModelPicker.js'
import { DeveloperApproval } from './DeveloperApproval.js'
import { DeveloperFileReview } from './DeveloperFileReview.js'
import { DeveloperAccess, DeveloperUsage, type AccessSelection } from './DeveloperControls.js'
import { DeveloperSkills } from './DeveloperSkills.js'
import { renderMarkdown } from '../lib/markdown.js'
const DeveloperCode = lazy(() => import('./DeveloperCode.js').then(module => ({ default: module.DeveloperCode })))

export const DeveloperMessage = memo(function DeveloperMessage({ item }: { item: DevItem }) {
  if (['tool', 'plan', 'agent'].includes(item.kind)) return <details className="dev-tool"><summary>{item.status === 'running' && <LoaderCircle size={13} className="spin" />}{item.kind === 'agent' ? 'Agent' : item.kind === 'plan' ? 'Plan' : item.text.split('\n')[0]?.slice(0, 100) || 'Tool'}<small>{item.status}</small></summary><pre>{item.text}</pre></details>
  return <article className={`dev-message dev-message-${item.kind}`}><div>{item.kind === 'user' ? item.text : renderMarkdown(item.text, (text, language, key) => <Suspense key={key} fallback={<pre><code>{text}</code></pre>}><DeveloperCode text={text} language={language} /></Suspense>)}</div></article>
})

export function DeveloperTaskPane({ id, slot, repo, state, active, split, onFocus, onCreated, onClose }: {
  id?: string; slot: number; repo?: DevRepo; state: DevState; active: boolean; split: boolean; onFocus(): void; onCreated(task: DevSession): void; onClose(): void
}) {
  const [task, setTask] = useState<DevSession | null>(null), [loading, setLoading] = useState(!!id), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [model, setModel] = useState<ModelSelection>({ engine: state.preferences.provider, model: '' })
  const [access, setAccess] = useState<AccessSelection>({ mode: 'review', isolate: false, confirmed: false })
  const [prompt, setPrompt] = useState(''), [visible, setVisible] = useState(100), [git, setGit] = useState<DevGitState | null>(null), [reviewPath, setReviewPath] = useState('')
  const [dismissedSkills, setDismissedSkills] = useState<string | null>(null)
  const [selected, setSelected] = useState<string[]>([]), [commit, setCommit] = useState('')
  const log = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), follow = useRef(true), request = useRef(0), gate = useRef(false)
  const draftKey = `engram.dev.draft.${id ?? `${repo?.id ?? 'empty'}.${slot}`}`
  useEffect(() => {
    const at = ++request.current
    setLoading(!!id); setTask(null); setError(''); setGit(null); setReviewPath(''); setVisible(100); follow.current = true
    try { setPrompt(sessionStorage.getItem(draftKey) ?? '') } catch { setPrompt('') }
    if (!id) { setAccess({ mode: 'review', isolate: false, confirmed: false }); return }
    void api.devSession(id).then(value => { if (at === request.current) setTask(value) }).catch(error => { if (at === request.current) setError(error.message) }).finally(() => { if (at === request.current) setLoading(false) })
    return () => { request.current++ }
  }, [id, draftKey])
  useEffect(() => api.onEvent(event => {
    if (event.type !== 'dev:changed' || !event.update || event.update.id !== id) return
    const update = event.update
    setTask(current => {
      if (!current) return current
      const incoming = new Map(update.items.map(item => [item.id, item]))
      const items = current.items.map(item => { const next = incoming.get(item.id); incoming.delete(item.id); return next ?? item })
      return { ...current, ...update, title: update.title ?? current.title, updatedAt: update.updatedAt ?? current.updatedAt, items: [...items, ...incoming.values()] }
    })
  }), [id])
  useEffect(() => { if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight }, [task?.items, task?.pending])
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.min(180, input.current.scrollHeight)}px` } }, [prompt])
  const write = (value: string) => { setPrompt(value); setDismissedSkills(null); try { if (value) sessionStorage.setItem(draftKey, value); else sessionStorage.removeItem(draftKey) } catch { /* The mounted composer still retains its draft. */ } }
  const action = async (work: () => Promise<unknown>) => { if (gate.current) return; gate.current = true; setBusy(true); setError(''); try { await work() } catch (error) { setError((error as Error).message) } finally { gate.current = false; setBusy(false) } }
  const running = !!task && ['starting', 'running', 'waiting', 'stopping'].includes(task.state)
  const chosenModel: ModelSelection = task ? { engine: task.provider, model: task.model, effort: task.effort } : model
  const chosenAccess: AccessSelection = task ? { mode: task.mode, isolate: !!task.branch, confirmed: task.mode === 'full-access' } : access
  const send = () => action(async () => {
    if (!prompt.trim() || !repo || running) return
    let current = task
    if (!current) {
      current = await api.devCreate({ repoId: repo.id, provider: model.engine, model: model.model, effort: model.effort, mode: access.mode, isolate: access.isolate || access.mode === 'auto-edit', fullAccessConfirmed: access.confirmed })
      setTask(current); onCreated(current)
    }
    const text = prompt.trim(); write(''); follow.current = true
    try { await api.devSend(current.id, text) } catch (error) { write(text); throw error }
  })
  const changeModel = async (value: ModelSelection) => {
    if (running || gate.current) throw new Error('Finish or stop the task before changing its model.')
    if (task) setTask(await api.devConfigure(task.id, { provider: value.engine, model: value.model, effort: value.effort, mode: task.mode, fullAccessConfirmed: task.mode === 'full-access' }))
    else setModel(value)
  }
  return <section className={`dev-pane${active ? ' active' : ''}${!task && !loading ? ' dev-pane-welcome' : ''}`} aria-label={`Development pane ${slot + 1}`} onFocusCapture={onFocus} onPointerDown={onFocus}>
    <header className="dev-header"><div className="dev-heading"><h2 title={task?.title}>{task?.title ?? (loading ? 'Loading session…' : 'New session')}</h2><small title={task?.cwd ?? repo?.path}><Folder size={12} />{repo?.name ?? 'Choose a folder'}{task?.branch && <span title={task.branch}> · Worktree</span>}</small></div>
      <div className="dev-actions">{task && <><button className="dev-control" aria-label="Branch session" title="Branch into a separate worktree" disabled={busy || running || !task.runtimeId} onClick={() => void action(async () => onCreated(await api.devFork(task.id)))}><GitBranch size={16} /></button><button className="dev-control" disabled={busy} onClick={() => void action(async () => { setGit(await api.devGit(task.id)); setSelected([]) })}>Changes</button></>}{split && <button className="dev-control" aria-label="Close pane" onClick={onClose}><X size={16} /></button>}</div>
    </header>
    {error && <div className="dev-error" role="alert">{error}<button className="dev-control" aria-label="Dismiss error" onClick={() => setError('')}><X size={14} /></button></div>}
    <div className="dev-log" ref={log} onScroll={event => { const view = event.currentTarget; follow.current = view.scrollHeight - view.scrollTop - view.clientHeight < 100 }}>
      {loading ? <div className="dev-empty" role="status"><LoaderCircle className="spin" />Loading conversation…</div> : !task && <div className="dev-empty"><h2>{repo ? `Work in ${repo.name}` : 'Choose a project'}</h2><p>{repo ? 'Ask about the code or describe a change.' : 'Add a folder from the sidebar to get started.'}</p></div>}
      {task && task.items.length > visible && <button className="secondary" onClick={() => { follow.current = false; setVisible(count => count + 100) }}>Show earlier messages</button>}
      {task?.items.slice(-visible).map(item => <DeveloperMessage key={item.id} item={item} />)}
      {task?.pending.map(approval => <DeveloperApproval key={approval.id} sessionId={task.id} approval={approval} />)}
      {running && <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" />{task?.state === 'waiting' ? 'Waiting for your response' : task?.state === 'stopping' ? 'Stopping the runtime…' : task?.state === 'starting' ? 'Connecting…' : 'Working…'}</p>}
    </div>
    <div className="dev-composer">
      {repo && !running && !busy && /^\/[^\s]*$/.test(prompt) && dismissedSkills !== prompt && <DeveloperSkills session={task?.id} repoId={repo.id} provider={chosenModel.engine} query={prompt.slice(1)} input={input} onSelect={value => { write(value); input.current?.focus() }} onDismiss={() => setDismissedSkills(prompt)} />}
      <textarea ref={input} aria-label="Development message" placeholder="Ask about the code, or describe a change…" value={prompt} disabled={running || busy || loading || !repo} onChange={event => write(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running && !loading) void send() } }} />
      <div className="dev-composer-toolbar"><div className="dev-composer-tools">
        <DeveloperAccess value={chosenAccess} task={task} disabled={running || busy || loading} extensions={state.preferences.loadProjectSettings} onChange={async value => { if (task) setTask(await api.devConfigure(task.id, { model: task.model, effort: task.effort, mode: value.mode, fullAccessConfirmed: value.confirmed })); else setAccess(value) }} />
      </div><fieldset className="dev-model-controls" disabled={running || busy || loading}><ModelPicker controlled={{ value: chosenModel, accountProfile: task ? task.accountProfile ?? 'system' : undefined, disabled: running || busy || loading, onChange: changeModel }} /></fieldset>
      <button className="dev-send" disabled={busy || loading || (!running && (!prompt.trim() || !repo))} aria-label={running ? 'Stop development task' : 'Send development message'} onClick={() => void (running && task ? action(() => api.devStop(task.id)) : send())}>{busy ? <LoaderCircle size={17} className="spin" /> : running ? <Square size={16} /> : <ArrowUp size={18} />}</button></div>
      <div className="dev-composer-foot"><span title={task?.cwd ?? repo?.path}>{chosenAccess.isolate ? <><GitBranch size={12} />Separate worktree</> : <><Folder size={12} />{repo?.name ?? 'No folder selected'}</>}</span><div><DeveloperUsage usage={task?.usage ?? {}} /><button className="dev-control" aria-label="AI settings" title="AI settings" onClick={() => window.dispatchEvent(new Event('engram:open-brain-setup'))}><Settings size={14} /></button></div></div>
    </div>
    {git && task && <aside className="dev-review" aria-label="Working tree changes"><header><strong>Working tree</strong><button className="dev-control" aria-label="Close changes" onClick={() => setGit(null)}><X size={16} /></button></header><small>{git.branch}</small>
      {git.files.map(file => <div key={file.path} className="dev-file-row"><input aria-label={`Include ${file.path} in commit`} type="checkbox" checked={selected.includes(file.path)} onChange={event => setSelected(current => event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path))} /><code>{file.status}</code><button onClick={() => setReviewPath(file.path)}>{file.path}</button></div>)}
      {reviewPath ? <DeveloperFileReview key={`${task.id}-${reviewPath}`} sessionId={task.id} path={reviewPath} locked={running} onChanged={() => { void api.devGit(task.id).then(setGit).catch(error => setError(error.message)) }} /> : <details open><summary>Tracked changes{git.truncated ? ' (truncated)' : ''}</summary><pre>{git.diff || 'No tracked text changes. Select a file above to review it.'}</pre></details>}
      <input aria-label="Commit message" placeholder="Commit message" value={commit} onChange={event => setCommit(event.target.value)} /><button className="primary" disabled={busy || running || !selected.length || !commit.trim()} onClick={() => void action(async () => { await api.devCommit(task.id, selected, commit); setGit(await api.devGit(task.id)); setSelected([]); setCommit(''); setReviewPath('') })}>Commit selected files</button>
      <button className="secondary" disabled={busy || running} onClick={() => { write('Review the current branch and help prepare a pull request for the committed changes. Explain what will be pushed and request approval before publishing. Do not include unrelated changes.'); setGit(null); input.current?.focus() }}>Ask to prepare a pull request</button>
    </aside>}
  </section>
}
