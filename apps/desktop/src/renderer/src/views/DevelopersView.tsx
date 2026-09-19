import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUp, Code2, FolderPlus, GitBranch, LoaderCircle, Plus, RefreshCw, Settings, Square, X } from 'lucide-react'
import type { DevCommand, DevExternalSession, DevGitState, DevItem, DevMode, DevProvider, DevSession, DevState, DevUsage } from '../../../shared/developers.js'
import type { ReasoningEffort } from 'core'
import { api } from '../api.js'
import { useModelChoices } from '../components/ModelPicker.js'
import { DeveloperApproval } from '../components/DeveloperApproval.js'
import { DeveloperFileReview } from '../components/DeveloperFileReview.js'
import { UsageSummary } from '../components/DeveloperSettings.js'
import { ProviderIcon } from '../components/ProviderIcon.js'
import { renderMarkdown } from '../lib/markdown.js'
const DeveloperCode = lazy(() => import('../components/DeveloperCode.js').then(module => ({ default: module.DeveloperCode })))

const Item = memo(function Item({ item }: { item: DevItem }) {
  if (['tool', 'plan', 'agent'].includes(item.kind)) return <details className="dev-tool"><summary>{item.status === 'running' && <LoaderCircle size={13} className="spin" />}{item.kind === 'agent' ? 'Agent' : item.kind === 'plan' ? 'Plan' : item.text.split('\n')[0]?.slice(0, 100) || 'Tool'}<small>{item.status}</small></summary><pre>{item.text}</pre></details>
  return <article className={`dev-message dev-message-${item.kind}`}><div>{item.kind === 'user' ? item.text : renderMarkdown(item.text, (text, language, key) => <Suspense key={key} fallback={<pre><code>{text}</code></pre>}><DeveloperCode text={text} language={language} /></Suspense>)}</div></article>
})

export function DevelopersView({ onBack }: { onBack(): void }) {
  const [state, setState] = useState<DevState | null>(null), [task, setTask] = useState<DevSession | null>(null)
  const [repoId, setRepoId] = useState(''), [provider, setProvider] = useState<DevProvider>('codex'), [model, setModel] = useState(''), [effort, setEffort] = useState<ReasoningEffort | undefined>()
  const [mode, setMode] = useState<DevMode>('review'), [isolate, setIsolate] = useState(true), [confirmed, setConfirmed] = useState(false)
  const [prompt, setPrompt] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [git, setGit] = useState<DevGitState | null>(null)
  const [selected, setSelected] = useState<string[]>([]), [commit, setCommit] = useState(''), [external, setExternal] = useState<DevExternalSession[] | null>(null)
  const [reviewPath, setReviewPath] = useState('')
  const [preview, setPreview] = useState<{ session: DevExternalSession; items: DevItem[] } | null>(null)
  const [accountUsage, setAccountUsage] = useState<{ provider: DevProvider; value: DevUsage } | null>(null), [usageBusy, setUsageBusy] = useState(false)
  const [commands, setCommands] = useState<{ id: string; rows: DevCommand[] } | null>(null)
  const [visibleItems, setVisibleItems] = useState(100)
  const [editingSettings, setEditingSettings] = useState(false)
  const serial = useRef(0), selectedId = useRef<string | null>(null), log = useRef<HTMLDivElement>(null), follow = useRef(true)
  const choices = useModelChoices(task && !editingSettings ? null : task?.provider ?? provider)
  const refresh = async () => { const value = await api.devState(); setState(value); return value }
  useEffect(() => {
    let alive = true
    void api.devState().then(value => { if (alive) { setState(value); setRepoId(value.repos[0]?.id ?? ''); setProvider(value.preferences.provider); setIsolate(value.preferences.isolate) } }).catch(error => { if (alive) setError(error.message) })
    const off = api.onEvent(event => {
      if (event.type !== 'dev:changed') return
      if (!event.update) { void refresh().catch(error => setError(error.message)); return }
      const update = event.update
      setState(current => {
        const before = current?.sessions.find(session => session.id === update.id)
        if (!current || !before || (before.state === update.state && (!update.runtimeId || before.runtimeId === update.runtimeId))) return current
        return { ...current, sessions: current.sessions.map(session => session.id === update.id ? { ...session, state: update.state, runtimeId: update.runtimeId ?? session.runtimeId } : session) }
      })
      if (update.id !== selectedId.current) return
      setTask(current => {
        if (!current || current.id !== update.id) return current
        const incoming = new Map(update.items.map(item => [item.id, item]))
        const items = current.items.map(item => { const next = incoming.get(item.id); incoming.delete(item.id); return next ?? item })
        return { ...current, ...update, items: [...items, ...incoming.values()] }
      })
    })
    return () => { alive = false; off(); serial.current++ }
  }, [])
  useEffect(() => { if (follow.current && log.current) log.current.scrollTop = log.current.scrollHeight }, [task?.items, task?.pending])
  const action = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await work() } catch (error) { setError((error as Error).message) } finally { setBusy(false) } }
  const openTask = async (id: string) => {
    const at = ++serial.current
    selectedId.current = id; setGit(null); setReviewPath(''); setExternal(null); setPreview(null); setVisibleItems(100); setEditingSettings(false)
    const value = await api.devSession(id)
    if (at === serial.current) { setTask(value); setRepoId(value.repoId); follow.current = true }
  }
  const start = async (resume?: string) => {
    if (!repoId || (mode === 'full-access' && !confirmed)) throw new Error('Choose a repository and confirm the selected access mode.')
    const next = await api.devCreate({ repoId, provider, model, effort, mode, isolate: mode === 'auto-edit' || isolate, fullAccessConfirmed: confirmed, ...(resume ? { resume, fork: true } : {}) })
    selectedId.current = next.id; setTask(next); setExternal(null); setPreview(null); setReviewPath(''); await refresh()
    return next
  }
  const send = () => action(async () => {
    if (!prompt.trim()) return
    const current = task ?? await start()
    const text = prompt.trim(); setPrompt('')
    try { await api.devSend(current.id, text); await refresh() }
    catch (error) { setPrompt(text); throw error }
  })
  const running = task && ['starting', 'running', 'waiting', 'stopping'].includes(task.state)
  return <div className="dev-workspace" data-testid="developers-view">
    <aside className="dev-rail"><button className="dev-back" onClick={onBack}><ArrowLeft size={16} />Back to chats</button>
      <div className="dev-rail-heading"><strong>Developers</strong><button className="icon-btn" aria-label="Add repository" disabled={busy} onClick={() => void action(async () => { const repo = await api.devAddRepo(); if (repo) setRepoId(repo.id); await refresh() })}><FolderPlus size={17} /></button></div>
      {state?.preferences.enabled && <button className="dev-new" onClick={() => { serial.current++; selectedId.current = null; setTask(null); setGit(null); setReviewPath(''); setExternal(null); setPreview(null); setPrompt(''); setEditingSettings(false); setConfirmed(false); setMode('review') }}><Plus size={16} />New task</button>}
      {state?.repos.map(repo => <section key={repo.id} className="dev-project"><button className={repoId === repo.id ? 'selected' : ''} title={repo.path} onClick={() => setRepoId(repo.id)}><GitBranch size={14} />{repo.name}</button>{state.sessions.filter(session => session.repoId === repo.id).sort((a, b) => b.updatedAt - a.updatedAt).map(session => <button key={session.id} className={`dev-task-link${task?.id === session.id ? ' selected' : ''}`} onClick={() => void action(() => openTask(session.id))}><ProviderIcon provider={session.provider} size={13} /><span>{session.title}</span></button>)}</section>)}
    </aside>
    <section className="dev-main">
      <header className="dev-header"><div><Code2 size={17} /><strong>{task?.title ?? 'Build something'}</strong></div><div className="dev-actions">{task && <><button className="secondary" disabled={busy || !!running || !task.runtimeId} title="Branch the conversation into a new worktree at its current commit. Uncommitted files are not copied." onClick={() => void action(async () => { const next = await api.devFork(task.id); await refresh(); await openTask(next.id) })}>Branch task</button><button className="secondary" disabled={busy} onClick={() => void action(async () => { setGit(await api.devGit(task.id)); setSelected([]) })}><GitBranch size={15} />Changes</button></>}<button className="icon-btn" aria-label="Developer settings" onClick={() => window.dispatchEvent(new Event('engram:open-developer-settings'))}><Settings size={16} /></button></div></header>
      {error && <div className="dev-error" role="alert">{error}<button className="icon-btn" aria-label="Dismiss error" onClick={() => setError('')}><X size={15} /></button></div>}
      {!state ? <div className="dev-empty" role="status"><LoaderCircle className="spin" />Loading workspace…</div> : !state.preferences.enabled ? <div className="dev-empty"><Code2 size={30} /><h2>A workspace for your code</h2><p>Keep development tasks separate from everyday chats. Use your existing AI connections.</p><button className="primary" disabled={busy} onClick={() => void action(async () => { await api.devPreferences({ enabled: true }); await refresh() })}>Enable Developers</button></div> : <>
        <div className="dev-log" ref={log} onScroll={event => { const view = event.currentTarget; follow.current = view.scrollHeight - view.scrollTop - view.clientHeight < 100 }}>
          {!task && <div className="dev-empty"><Code2 size={28} /><h2>What are we building?</h2><p>Choose a folder, then describe a change or ask about the code.</p>{!state.repos.length && <button className="secondary" disabled={busy} onClick={() => void action(async () => { const repo = await api.devAddRepo(); if (repo) setRepoId(repo.id); await refresh() })}><FolderPlus size={16} />Choose folder</button>}</div>}
          {task && task.items.length > visibleItems && <button className="secondary" onClick={() => { follow.current = false; setVisibleItems(count => count + 100) }}>Show earlier messages</button>}
          {task?.items.slice(-visibleItems).map(item => <Item key={item.id} item={item} />)}
          {task?.pending.map(approval => <DeveloperApproval key={approval.id} sessionId={task.id} approval={approval} />)}
          {running && <p className="dev-working" role="status"><LoaderCircle size={14} className="spin" />{task.state === 'waiting' ? 'Waiting for your response' : task.state === 'stopping' ? 'Stopping the runtime…' : task.state === 'starting' ? 'Connecting to your runtime…' : 'Working…'}</p>}
          {external && <section className="dev-external"><h3>External sessions</h3><p>Read saved messages before branching. Live sessions are never taken over.</p>{external.length ? external.map(session => <button key={session.id} className="secondary" disabled={busy} onClick={() => void action(async () => setPreview({ session, items: await api.devExternalRead(repoId, provider, session.id) }))}>{session.title}<small>{session.active ? 'Active elsewhere' : new Date(session.updatedAt).toLocaleDateString('en-US')}</small></button>) : <p>No sessions found for this repository.</p>}</section>}
          {preview && <section className="dev-external" aria-label="Saved session preview"><h3>{preview.session.title}</h3><p>Read-only snapshot, up to 200 messages. New messages from other clients are not streamed here.</p><button className="secondary" disabled={busy || preview.session.active} onClick={() => void action(() => start(preview.session.id))}>Branch into a new task</button><button className="secondary" onClick={() => setPreview(null)}>Close preview</button>{preview.items.length ? preview.items.map(item => <Item key={item.id} item={item} />) : <p>No saved text messages are available.</p>}</section>}
        </div>
        <div className="dev-composer">
          {task && <div className="dev-options"><button className="secondary" disabled={busy || !!running} onClick={() => void action(async () => setCommands({ id: task.id, rows: await api.devCommands(task.id) }))}>Skills</button>{commands?.id === task.id && <select aria-label="Choose a skill" value="" onChange={event => { setPrompt(event.target.value); setCommands(null) }}><option value="">{commands.rows.length ? 'Choose a skill…' : 'No skills reported by this runtime'}</option>{commands.rows.map(command => <option key={command.name} value={command.prompt}>{command.name} — {command.description}</option>)}</select>}</div>}
          {!task && <div className="dev-options"><select aria-label="Repository" value={repoId} onChange={event => setRepoId(event.target.value)}><option value="" disabled>Choose repository</option>{state.repos.map(repo => <option key={repo.id} value={repo.id}>{repo.name}</option>)}</select><button className="secondary" disabled={!repoId || busy} onClick={() => void action(async () => setExternal(await api.devExternal(repoId, provider)))}>Previous sessions</button></div>}
          <textarea aria-label="Development message" placeholder="Describe a change, ask about the code, or run a skill…" value={prompt} disabled={!!running || editingSettings} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!running && !busy && !editingSettings) void send() } }} />
          <div className="dev-options">{task && !editingSettings ? <><span className="dev-task-meta"><ProviderIcon provider={task.provider} />{task.model || task.provider} · {task.effort || 'Auto'} · {task.mode}</span><button className="icon-btn" aria-label="Change task model and access" disabled={busy || !!running} onClick={() => { setProvider(task.provider); setModel(task.model); setEffort(task.effort); setMode(task.mode); setConfirmed(false); setEditingSettings(true) }}><Settings size={14} /></button></> : <>
            <select aria-label="Development provider" disabled={!!task} value={provider} onChange={event => { setProvider(event.target.value as DevProvider); setModel(''); setEffort(undefined); setExternal(null) }}><option value="codex">Codex</option><option value="claude">Claude</option></select>
            <select aria-label="Development model" value={model} onChange={event => { setModel(event.target.value); setEffort(undefined) }}><option value="">Default model</option>{choices.rows.map(row => <option key={row.value} value={row.value}>{row.label}</option>)}</select>{choices.loading && <LoaderCircle size={14} className="spin" />}{choices.error && <button className="icon-btn" aria-label="Retry model list" onClick={choices.refresh}><RefreshCw size={14} /></button>}
            <select aria-label="Reasoning effort" value={effort ?? ''} onChange={event => setEffort(event.target.value as ReasoningEffort || undefined)}><option value="">Auto effort</option>{choices.rows.find(row => row.value === model)?.efforts?.map(value => <option key={value} value={value}>{value}</option>)}</select>
            <select aria-label="Task access" value={mode} onChange={event => { setMode(event.target.value as DevMode); setConfirmed(false) }}><option value="review">Review changes</option><option value="plan">Plan only</option><option value="auto-edit">Automatic edits</option><option value="full-access">Full access</option></select>
          </>}
          <button className="dev-send" disabled={busy || editingSettings || (!running && (!prompt.trim() || (!task && !repoId)))} aria-label={running ? 'Stop development task' : 'Send development message'} onClick={() => void (running ? action(() => api.devStop(task!.id)) : send())}>{busy ? <LoaderCircle size={17} className="spin" /> : running ? <Square size={16} /> : <ArrowUp size={18} />}</button></div>
          {!task && <div className="dev-options"><label><input type="checkbox" checked={mode === 'auto-edit' || isolate} disabled={mode === 'auto-edit'} onChange={event => setIsolate(event.target.checked)} />Isolated worktree</label>{mode === 'full-access' && <label className="dev-warning"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I allow commands and file changes without approval.</label>}</div>}
          {task && editingSettings && <div className="dev-options">{mode === 'full-access' && <label className="dev-warning"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />I allow commands and file changes without approval.</label>}<button className="secondary" disabled={busy} onClick={() => setEditingSettings(false)}>Cancel changes</button><button className="primary" disabled={busy || (mode === 'full-access' && !confirmed)} onClick={() => void action(async () => { setTask(await api.devConfigure(task.id, { model, effort, mode, fullAccessConfirmed: confirmed })); setEditingSettings(false) })}>Apply task settings</button></div>}
          {(!task || editingSettings) && mode === 'full-access' && state.preferences.loadProjectSettings && <p className="dev-warning">Installed provider hooks and project configuration will also run without Engram approval prompts.</p>}
          {task && <small className="dev-token-count">{task.usage.input !== undefined ? `${task.usage.input.toLocaleString('en-US')} input · ${(task.usage.output ?? 0).toLocaleString('en-US')} output tokens` : 'Token usage appears when reported by the provider.'}{task.usage.cost !== undefined && ` · $${task.usage.cost.toFixed(4)} estimated API cost (not your subscription bill)`}</small>}
          {task && <details><summary>Account limits</summary><button className="secondary" disabled={usageBusy} onClick={() => { const engine = task.provider; setUsageBusy(true); void api.devUsage(engine).then(value => setAccountUsage({ provider: engine, value })).catch(error => setError(error.message)).finally(() => setUsageBusy(false)) }}>{usageBusy ? <LoaderCircle size={14} className="spin" /> : <RefreshCw size={14} />}Refresh limits</button><UsageSummary usage={accountUsage?.provider === task.provider ? accountUsage.value : null} /></details>}
        </div>
      </>}
    </section>
    {git && task && <aside className="dev-review">
      <header><strong>Working tree</strong><button className="icon-btn" aria-label="Close changes" onClick={() => setGit(null)}><X size={16} /></button></header><small>{git.branch}</small>
      {git.files.map(file => <div key={file.path} className="dev-file-row"><input aria-label={`Include ${file.path} in commit`} type="checkbox" checked={selected.includes(file.path)} onChange={event => setSelected(current => event.target.checked ? [...current, file.path] : current.filter(path => path !== file.path))} /><code>{file.status}</code><button onClick={() => setReviewPath(file.path)}>{file.path}</button></div>)}
      {reviewPath ? <DeveloperFileReview key={`${task.id}-${reviewPath}`} sessionId={task.id} path={reviewPath} locked={!!running} onChanged={() => { void api.devGit(task.id).then(setGit).catch(error => setError(error.message)) }} /> : <details open><summary>Tracked changes{git.truncated ? ' (truncated)' : ''}</summary><pre>{git.diff || 'No tracked text changes. Select a file above to review it.'}</pre></details>}
      <input aria-label="Commit message" placeholder="Commit message" value={commit} onChange={event => setCommit(event.target.value)} /><button className="primary" disabled={busy || !!running || !selected.length || !commit.trim()} onClick={() => void action(async () => { await api.devCommit(task.id, selected, commit); setGit(await api.devGit(task.id)); setSelected([]); setCommit(''); setReviewPath('') })}>Commit selected files</button>
      <button className="secondary" disabled={busy || !!running} onClick={() => { setPrompt('Review the current branch and its remote. Help me prepare a pull request for the committed changes. Explain what will be pushed and request approval before publishing anything. Do not include unrelated changes.'); setGit(null); log.current?.parentElement?.querySelector('textarea')?.focus() }}>Ask to prepare a pull request</button>
    </aside>}
  </div>
}
