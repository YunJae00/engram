import { ArrowLeft, Code2, MessageSquare, FolderPlus, PanelLeftClose, Plus, Repeat2, Search, Settings, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BotDto, RoutineDto, SidebarLayout, SidebarKind, SidebarChange } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { cometThreads, loadCometThread, selectComet } from '../lib/cometThreadsLive.js'
import { cometOfChannel } from '../lib/cometThreads.js'
import { useCometActivity } from '../lib/useCometActivity.js'
import { useShellState } from '../state-slices.js'
import { SidebarStatus } from './SidebarStatus.js'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js'
import { SidebarCollection } from './SidebarCollection.js'
import { SidebarConversation } from './SidebarConversation.js'
import { RecentWeb } from './RecentWeb.js'
import { watchAccountUsage } from '../lib/accountUsage.js'

interface Props {
  open: boolean; onToggle(): void; onOpenPalette(): void; onOpenSettings(): void; onOpenRoutines(): void
  selectedRoutineId: string | null; onSelectRoutine(id: string): void
}

export function AppSidebar({ open, onToggle, onOpenPalette, onOpenSettings, onOpenRoutines, selectedRoutineId, onSelectRoutine }: Props) {
  const { activity, setActivity, vaultReady, showToast } = useShellState()
  const library = activity === 'routines'
  const developer = activity === 'developers'
  useEffect(() => { if (vaultReady) return watchAccountUsage() }, [vaultReady])
  const [bots, setBots] = useState<BotDto[]>([])
  const [routines, setRoutines] = useState<RoutineDto[]>([])
  const [query, setQuery] = useState('')
  const [layout, setLayout] = useState<SidebarLayout | null>(null)
  const [layoutError, setLayoutError] = useState('')
  const [creating, setCreating] = useState({ chat: 0, routine: 0 })
  const reloadGeneration = useRef(0)
  const selectedId = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.getSnapshot().selectedId)
  const activityOf = useCometActivity()
  const reload = async () => {
    if (!vaultReady) return
    const generation = ++reloadGeneration.current
    const selectedBefore = cometThreads.getSnapshot().selectedId
    const [nextBots, nextRoutines, nextLayout] = await Promise.all([
      api.botsList(), library ? api.routinesList() : Promise.resolve(null),
      api.sidebarLayout(library ? 'routine' : 'chat').catch(error => { setLayoutError(String(error.message ?? error)); return null }),
    ])
    if (generation !== reloadGeneration.current) return
    setBots(nextBots); if (nextRoutines) setRoutines(nextRoutines)
    if (nextLayout) { setLayout(nextLayout); setLayoutError('') }
    const current = cometThreads.getSnapshot().selectedId
    if (current && current === selectedBefore && !nextBots.some(bot => bot.id === current)) selectComet(null)
  }
  useEffect(() => {
    void reload().catch(error => showToast(String(error)))
    if (!vaultReady) return
    void api.chatActive().then(channels => Promise.all(channels.map(channel => {
      const id = cometOfChannel(channel)
      return id ? loadCometThread(id).catch(() => undefined) : undefined
    }))).catch(() => undefined)
    let debounce: number | undefined
    const off = api.onEvent(event => {
      // Filing changes notes, not conversations. Routine files still use the
      // vault event and are refreshed when their library is visible.
      if (event.type === 'vault:changed' && !library) return
      if (!['bots:changed', 'vault:changed', 'routine:logged', 'chat:done', 'chat:error'].includes(event.type)) return
      reloadGeneration.current++
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => void reload().catch(error => showToast(String(error))), 100)
    })
    return () => { reloadGeneration.current++; window.clearTimeout(debounce); off() }
  }, [vaultReady, library])
  useEffect(() => { setQuery('') }, [library])
  const navigate = (next: 'bots' | 'sky' | 'list' | 'mission') => { setActivity(next); if (window.innerWidth <= 900) onToggle() }
  const change = async (kind: SidebarKind, change: SidebarChange['change']) => { setLayout(await api.sidebarChange({ kind, change })) }
  const rename = async (kind: SidebarKind, id: string, name: string) => { if (kind === 'chat') await api.botRename(id, name); else await api.routineRename(id, name); await reload() }
  const remove = async (kind: SidebarKind, id: string) => { if (kind === 'chat') { await api.botDelete(id); cometThreads.forget(id) } else await api.routineRemove(id); await reload() }
  const newFolder = (kind: SidebarKind) => setCreating(current => ({ ...current, [kind]: current[kind] + 1 }))
  const search = query.trim().toLocaleLowerCase()
  const matchingBots = search ? bots.filter(bot => `${bot.name} ${bot.lastMessage?.text ?? ''} ${bot.purpose}`.toLocaleLowerCase().includes(search)) : bots
  const matchingIds = new Set(matchingBots.map(bot => bot.id))
  const matchingLayout = search && layout ? { ...layout.chat, folders: layout.chat.folders.filter(folder => layout.chat.items.some(item => item.folder === folder.id && matchingIds.has(item.id))).map(folder => ({ ...folder, collapsed: false })) } : layout?.chat
  const matchingRoutines = search ? routines.filter(routine => routine.name.toLocaleLowerCase().includes(search)) : routines
  const routineIds = new Set(matchingRoutines.map(routine => routine.id))
  const routineLayout = search && layout ? { ...layout.routine, folders: layout.routine.folders.filter(folder => layout.routine.items.some(item => item.folder === folder.id && routineIds.has(item.id))).map(folder => ({ ...folder, collapsed: false })) } : layout?.routine
  const collection = (kind: SidebarKind) => <SidebarCollection key={kind} kind={kind} newFolder={creating[kind]}
    items={kind === 'chat' ? matchingBots.map(bot => ({ id: bot.id, name: bot.name, active: bot.id === selectedId && (activity === 'bots' || activity === 'mission'), content: <SidebarConversation bot={bot} state={activityOf(bot)} /> })) : matchingRoutines.map(routine => ({ ...routine, active: routine.id === selectedRoutineId, content: <><span className="sidebar-routine-icon"><Repeat2 size={17} strokeWidth={1.6} aria-hidden /></span><span className="sidebar-routine-copy"><strong>{routine.name}</strong><small>{routine.task ? routine.task.surface === 'web' ? 'Browser task' : 'Comet task' : `${routine.steps.length} steps`}{routine.lastOutcome && ` · ${routine.lastOutcome === 'done' ? 'Last run completed' : routine.lastOutcome === 'aborted' ? 'Paused' : 'Needs attention'}`}</small></span></> }))}
    layout={(kind === 'chat' ? matchingLayout : routineLayout) ?? { folders: [], items: (kind === 'chat' ? bots : routines).map(one => ({ id: one.id, folder: null })) }}
    onChange={changeValue => change(kind, changeValue)} onRename={(id, name) => rename(kind, id, name)} onRemove={id => remove(kind, id)} onError={showToast}
    onOpen={id => { if (kind === 'chat') { selectComet(id); navigate('bots') } else { onSelectRoutine(id); if (window.innerWidth <= 900) onToggle() } }} />
  return <aside className={`app-sidebar${open ? ' open' : ''}`} data-testid="app-sidebar" aria-hidden={!open}>
    {!library && !developer && <RecentWeb bots={bots} onOpen={() => { if (window.innerWidth <= 900) onToggle() }} />}
    <div className="app-sidebar-head"><WorkspaceSwitcher activity={activity} onNavigate={navigate} onOpenRoutines={onOpenRoutines} onOpenPalette={onOpenPalette} /><button className="sidebar-icon-button" aria-label={developer ? 'Chat mode' : 'Developers mode'} title={developer ? 'Switch to chats' : 'Switch to Developers'} onClick={() => setActivity(developer ? 'bots' : 'developers')}>{developer ? <MessageSquare size={17} aria-hidden /> : <Code2 size={17} aria-hidden />}</button><button className="sidebar-icon-button" data-testid="app-sidebar-close" title={t('rail.hide')} aria-label={t('rail.hide')} onClick={onToggle}><PanelLeftClose size={17} strokeWidth={1.8} aria-hidden /></button></div>
    {developer ? <div id="developer-sidebar" className="developer-sidebar-content" /> : <>
    {library ? <button className="sidebar-new" onClick={() => navigate('bots')}><ArrowLeft size={17} aria-hidden /><span>Conversations</span></button> : <button className="sidebar-new" data-testid="bots-new" disabled={!vaultReady} onClick={() => { setActivity('bots'); selectComet(null); setQuery(''); if (window.innerWidth <= 900) onToggle() }}><Plus size={17} strokeWidth={1.9} aria-hidden /><span>{t('bots.new')}</span></button>}
    <div className="sidebar-library-tools"><div className="sidebar-search"><Search size={14} aria-hidden /><input aria-label={library ? 'Search routines' : 'Search conversations'} placeholder={library ? 'Search routines' : 'Search conversations'} value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Clear search" onClick={() => setQuery('')}><X size={13} aria-hidden /></button>}</div><button className="sidebar-icon-button" aria-label={library ? 'New routine folder' : 'New chat folder'} title="New folder" onClick={() => newFolder(library ? 'routine' : 'chat')}><FolderPlus size={16} aria-hidden /></button></div>
    <div className="sidebar-scroll">
      {layoutError && <p className="sidebar-empty" role="alert">{layoutError}</p>}
      <section className="sidebar-section sidebar-conversations" aria-label={library ? 'Saved routines' : 'Conversations'}>
        {library && <h2 className="sidebar-library-title">Routines</h2>}
        {collection(library ? 'routine' : 'chat')}
        {!(library ? matchingRoutines : matchingBots).length && <p className="sidebar-empty">{search ? 'No matches found' : library ? t('sidebar.noRoutines') : 'Your conversations will appear here.'}</p>}
      </section>
    </div>
    </>}
    <footer className="sidebar-footer">
      <SidebarStatus />
      <button data-testid="activity-settings" aria-label={t('sidebar.settings')} title={t('sidebar.settings')} onClick={onOpenSettings}><Settings size={16} aria-hidden /><span>{t('sidebar.settings')}</span></button>
    </footer>
  </aside>
}
