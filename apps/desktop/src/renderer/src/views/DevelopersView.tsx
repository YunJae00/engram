import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, ChevronRight, Folder, FolderPlus, History, LoaderCircle, MoreHorizontal, Plus } from 'lucide-react'
import type { DevRepo, DevSession, DevState } from '../../../shared/developers.js'
import { api } from '../api.js'
import { ProviderIcon } from '../components/ProviderIcon.js'
import { DeveloperTaskPane } from '../components/DeveloperTaskPane.js'
import { DeveloperHistory } from '../components/DeveloperHistory.js'
import { DeveloperPopover } from '../components/DeveloperControls.js'
import { SidebarDisclosure } from '../components/SidebarDisclosure.js'

interface Slot { id?: string; repoId?: string }
const emptySlots = (): Slot[] => Array.from({ length: 4 }, () => ({}))
function savedSlots(): Slot[] {
  try { const value = JSON.parse(sessionStorage.getItem('engram.dev.panes') ?? 'null'); if (Array.isArray(value) && value.length === 4 && value.every(slot => slot && typeof slot === 'object')) return value.map(slot => ({ id: typeof slot.id === 'string' ? slot.id : undefined, repoId: typeof slot.repoId === 'string' ? slot.repoId : undefined })) } catch { /* A fresh layout is safe when storage is unavailable. */ }
  return emptySlots()
}
export function DevelopersView({ layout, onLayout }: { layout: 1 | 2 | 4; onLayout(count: 1 | 2 | 4): void }) {
  const [sidebar, setSidebar] = useState<HTMLElement | null>(null)
  useEffect(() => { setSidebar(document.getElementById('developer-sidebar')) }, [])
  const [state, setState] = useState<DevState | null>(null), [slots, setSlots] = useState(savedSlots), [active, setActive] = useState(0), [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [history, setHistory] = useState<DevRepo | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const refresh = async () => { const value = await api.devState(); setState(value); return value }
  useEffect(() => {
    let alive = true
    void api.devState().then(value => { if (alive) setState(value) }).catch(error => { if (alive) setError(error.message) })
    const off = api.onEvent(event => {
      if (event.type !== 'dev:changed') return
      if (!event.update) { void api.devState().then(value => { if (alive) setState(value) }).catch(error => { if (alive) setError(error.message) }); return }
      const update = event.update
      setState(current => {
        const before = current?.sessions.find(session => session.id === update.id)
        if (!current || !before || (before.state === update.state && (!update.runtimeId || before.runtimeId === update.runtimeId) && (!update.title || before.title === update.title) && (!update.updatedAt || before.updatedAt === update.updatedAt))) return current
        return { ...current, sessions: current.sessions.map(session => session.id === update.id ? { ...session, state: update.state, runtimeId: update.runtimeId ?? session.runtimeId, title: update.title ?? session.title, updatedAt: update.updatedAt ?? session.updatedAt } : session) }
      })
    })
    return () => { alive = false; off() }
  }, [])
  useEffect(() => { try { sessionStorage.setItem('engram.dev.panes', JSON.stringify(slots)) } catch { /* The current layout remains available in memory. */ } }, [slots])
  const focused = Math.min(active, layout - 1)
  const action = async (work: () => Promise<unknown>) => { if (busy) return; setBusy(true); setError(''); try { await work() } catch (error) { setError((error as Error).message) } finally { setBusy(false) } }
  const open = (id: string, index = focused) => {
    const existing = slots.slice(0, layout).findIndex(slot => slot.id === id)
    if (existing >= 0) { setActive(existing); return }
    const session = state?.sessions.find(session => session.id === id)
    setSlots(current => current.map((slot, at) => at === index ? { id, repoId: session?.repoId } : slot.id === id ? {} : slot)); setActive(index)
  }
  const fresh = (repoId: string | undefined, index = focused) => { setSlots(current => current.map((slot, at) => at === index ? { repoId } : slot)); setActive(index); if (repoId) setCollapsed(current => ({ ...current, [repoId]: false })) }
  const choose = (id: string | undefined, repoId: string, index: number) => {
    if (!id) { fresh(repoId, index); return }
    setSlots(current => {
      const other = current.slice(0, layout).findIndex(slot => slot.id === id)
      return current.map((slot, at) => at === index ? { id, repoId } : at === other ? current[index]! : slot.id === id ? {} : slot)
    })
    setActive(index)
  }
  const created = (task: DevSession, index: number, expected: Slot) => {
    setState(current => current && { ...current, sessions: [...current.sessions.filter(session => session.id !== task.id), task] })
    setSlots(current => current.map((slot, at) => at === index && slot === expected ? { id: task.id, repoId: task.repoId } : slot))
  }
  const add = () => action(async () => { if (!state?.preferences.enabled) await api.devPreferences({ enabled: true }); const repo = await api.devAddRepo(); await refresh(); if (repo) fresh(repo.id) })
  const closePane = (index: number) => {
    setSlots(current => [...current.slice(0, index), ...current.slice(index + 1), {}].slice(0, 4))
    setActive(0); onLayout(layout === 4 ? 2 : 1)
  }
  return <div className="dev-workspace" data-testid="developers-view">
    {sidebar && createPortal(<section className="dev-rail" aria-label="Development projects"><div className="dev-rail-heading"><strong>Projects</strong><button className="dev-control" aria-label="Add repository" title="Add folder" disabled={busy} onClick={() => void add()}><FolderPlus size={16} /></button></div>
      <div className="dev-projects">{state?.repos.map(repo => <section key={repo.id} className="dev-project"><div className="dev-project-heading"><button className="dev-folder-button" title={repo.path} aria-expanded={!collapsed[repo.id]} onClick={() => setCollapsed(current => ({ ...current, [repo.id]: !current[repo.id] }))}>{collapsed[repo.id] ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<Folder size={15} /><span>{repo.name}</span></button><button className="dev-control" aria-label={`New session in ${repo.name}`} title="New session" onClick={() => fresh(repo.id)}><Plus size={15} /></button><DeveloperPopover label={`Project options for ${repo.name}`} trigger={<MoreHorizontal size={15} />}>{close => <><button className="dev-menu-row" onClick={() => { setHistory(repo); close() }}><History size={15} />Previous sessions</button><button className="dev-menu-row" onClick={() => { close(); void action(async () => { await api.devRemoveRepo(repo.id); setSlots(current => current.map(slot => slot.repoId === repo.id ? {} : slot)); await refresh() }) }}>Remove from sidebar</button><p className="setting-hint">Files and session history are kept. Add the folder again to restore it.</p></>}</DeveloperPopover></div>
        <SidebarDisclosure id={`dev-folder-${repo.id}`} open={!collapsed[repo.id]} unmountOnExit><div className="dev-project-sessions">{state.sessions.filter(session => session.repoId === repo.id).sort((a, b) => b.updatedAt - a.updatedAt).map(session => <button key={session.id} className={`dev-task-link${slots[focused]?.id === session.id ? ' selected' : ''}`} title={session.title} aria-current={slots[focused]?.id === session.id ? 'page' : undefined} onClick={() => open(session.id)}>{['starting', 'running', 'waiting', 'stopping'].includes(session.state) ? <LoaderCircle size={13} className="spin" /> : <ProviderIcon provider={session.provider} size={13} />}<span>{session.title}</span>{slots.slice(0, layout).some(slot => slot.id === session.id) && <small>{slots.findIndex(slot => slot.id === session.id) + 1}</small>}</button>)}{!state.sessions.some(session => session.repoId === repo.id) && <button className="dev-empty-session" onClick={() => fresh(repo.id)}>Start a session</button>}</div></SidebarDisclosure>
      </section>)}</div>
    </section>, sidebar)}
    <main className="dev-content">{error && <p className="dev-error" role="alert">{error}</p>}{!state ? <div className="dev-empty" role="status"><LoaderCircle className="spin" />Loading workspace…</div> : !state.preferences.enabled ? <div className="dev-empty"><h2>Code, in conversation</h2><p>Use your AI connection to work in a project. Development stays off until you enable it.</p><button className="primary" disabled={busy} onClick={() => void action(async () => { await api.devPreferences({ enabled: true }); await refresh() })}>Enable Developers</button></div> : !state.repos.length ? <div className="dev-empty"><Folder size={28} /><h2>Choose your first project</h2><p>Add a folder. Its sessions will appear together in the sidebar.</p><button className="primary" disabled={busy} onClick={() => void add()}>Add folder</button></div> : <div className={`dev-panes dev-panes-${layout}`}>
      {slots.slice(0, layout).map((slot, index) => <DeveloperTaskPane key={`${index}:${slot.id ?? slot.repoId ?? ''}`} slot={index} id={state.sessions.some(session => session.id === slot.id) ? slot.id : undefined} repo={state.repos.find(repo => repo.id === (state.sessions.find(session => session.id === slot.id)?.repoId ?? slot.repoId)) ?? state.repos[0]} state={state} active={focused === index} split={layout > 1} onFocus={() => setActive(index)} onCreated={task => created(task, index, slot)} onClose={() => closePane(index)} onChoose={(id, repoId) => choose(id, repoId, index)} />)}
    </div>}</main>
    {history && state && <DeveloperHistory repo={history} provider={state.preferences.provider} onClose={() => setHistory(null)} onImported={task => { setHistory(null); created(task, focused, slots[focused]!) }} />}
  </div>
}
