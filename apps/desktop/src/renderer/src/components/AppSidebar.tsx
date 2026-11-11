import { ArrowLeft, FolderPlus, PanelLeftClose, Plus, Repeat2, Search, Settings, X } from 'lucide-react'
import { NoticesBell } from './NoticesBell.js'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { flushSync } from 'react-dom'
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
import { watchAccountUsage } from '../lib/accountUsage.js'
import { WorkspaceMode } from './WorkspaceMode.js'
import { SidebarPrimary } from './SidebarPrimary.js'
import { groupSidebarBots, matchesSidebarSearch } from '../lib/sidebarBots.js'
import { CreateBotDialog } from './CreateBotDialog.js'

interface Props {
  developer: boolean
  open: boolean; onToggle(): void; onOpenSettings(): void
  selectedRoutineId: string | null; onSelectRoutine(id: string): void
}

const NO_HITS: ReadonlySet<string> = new Set()

export function AppSidebar({ developer, open, onToggle, onOpenSettings, selectedRoutineId, onSelectRoutine }: Props) {
  const { activity, setActivity, vaultReady, showToast } = useShellState()
  const library = activity === 'routines'
  useEffect(() => { if (vaultReady) return watchAccountUsage() }, [vaultReady])
  const [bots, setBots] = useState<BotDto[]>([])
  const [routines, setRoutines] = useState<RoutineDto[]>([])
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const searchId = useId(), searchToggle = useRef<HTMLButtonElement>(null), composing = useRef(false)
  const [bodyHits, setBodyHits] = useState<{ query: string; ids: Set<string> }>({ query: '', ids: new Set() })
  const createId = useId(), createMenu = useRef<HTMLDivElement>(null), searchInput = useRef<HTMLInputElement>(null)
  const [layout, setLayout] = useState<SidebarLayout | null>(null)
  const [layoutError, setLayoutError] = useState('')
  const [creating, setCreating] = useState({ chat: 0, routine: 0 })
  const [waiting, setWaiting] = useState<Set<string>>(new Set())
  const [creatingBot, setCreatingBot] = useState(false)
  useEffect(() => { const open = () => setCreatingBot(true); window.addEventListener('engram:open-create-bot', open); return () => window.removeEventListener('engram:open-create-bot', open) }, [])
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
  // Conversations whose task still runs or waits for the person never drop out of sight.
  useEffect(() => {
    if (!vaultReady) return
    const load = () => void api.tasksList().then(tasks => setWaiting(new Set(tasks.filter(task => ['queued', 'running', 'waiting'].includes(task.state)).map(task => task.botId)))).catch(() => undefined)
    load()
    return api.onEvent(event => { if (event.type === 'tasks:changed') load() })
  }, [vaultReady])
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
  useEffect(() => { setQuery(''); setSearchOpen(false) }, [library])
  const navigate = (next: 'bots' | 'developers' | 'sky' | 'list' | 'mission') => { setActivity(next); if (window.innerWidth <= 900) onToggle() }
  const change = async (kind: SidebarKind, change: SidebarChange['change']) => { const next = await api.sidebarChange({ kind, change }); setLayout(next); return next }
  const updateBot = async (id: string, patch: { hidden?: true; primary?: true }) => { await api.botUpdate(id, patch); await reload() }
  // The new section is the one folder id the create call added; names can repeat, so never look it up by name.
  const newSection = async (id: string, name: string) => {
    const before = new Set((await api.sidebarLayout('chat')).chat.folders.map(folder => folder.id))
    const added = (await change('chat', { action: 'create-folder', name })).chat.folders.filter(folder => !before.has(folder.id))
    if (added.length !== 1 || !added[0]) throw new Error(t('sidebar.sectionUnknown'))
    await change('chat', { action: 'move-item', id, folder: added[0].id })
  }
  const rename = async (kind: SidebarKind, id: string, name: string) => { if (kind === 'chat') await api.botRename(id, name); else await api.routineRename(id, name); await reload() }
  const remove = async (kind: SidebarKind, id: string) => { if (kind === 'chat') { await api.botDelete(id); cometThreads.forget(id) } else await api.routineRemove(id); await reload() }
  const newFolder = (kind: SidebarKind) => setCreating(current => ({ ...current, [kind]: current[kind] + 1 }))
  const search = query.trim().toLocaleLowerCase()
  useEffect(() => {
    if (!search || library || !vaultReady) return
    let live = true
    const timer = window.setTimeout(() => void api.botsSearch(search).then(ids => { if (live) setBodyHits({ query: search, ids: new Set(ids) }) }).catch(() => undefined), 150)
    return () => { live = false; window.clearTimeout(timer) }
  }, [search, library, vaultReady, bots])
  const live = (bot: BotDto) => waiting.has(bot.id) || ['running', 'waiting'].includes(activityOf(bot))
  const { hero, listed, hidden } = groupSidebarBots(bots)
  const hits = bodyHits.query === search ? bodyHits.ids : NO_HITS
  const matchingBots = listed.filter(bot => matchesSidebarSearch(bot, search, hits))
  const matchingHidden = hidden.filter(bot => matchesSidebarSearch(bot, search, hits))
  const botItem = (bot: BotDto) => ({ id: bot.id, name: bot.name, active: bot.id === selectedId && (activity === 'bots' || activity === 'mission'), recency: live(bot) ? Number.MAX_SAFE_INTEGER : Date.parse(bot.lastMessage?.at ?? bot.createdAt), content: <SidebarConversation bot={bot} state={activityOf(bot)} active={bot.id === selectedId && (activity === 'bots' || activity === 'mission')} />, bot })
  const openBot = (id: string) => { selectComet(id); navigate('bots') }
  const matchingIds = new Set(matchingBots.map(bot => bot.id))
  const matchingLayout = search && layout ? { ...layout.chat, folders: layout.chat.folders.filter(folder => layout.chat.items.some(item => item.folder === folder.id && matchingIds.has(item.id))).map(folder => ({ ...folder, collapsed: false })) } : layout?.chat
  const matchingRoutines = search ? routines.filter(routine => routine.name.toLocaleLowerCase().includes(search)) : routines
  const routineIds = new Set(matchingRoutines.map(routine => routine.id))
  const routineLayout = search && layout ? { ...layout.routine, folders: layout.routine.folders.filter(folder => layout.routine.items.some(item => item.folder === folder.id && routineIds.has(item.id))).map(folder => ({ ...folder, collapsed: false })) } : layout?.routine
  const collection = (kind: SidebarKind) => <SidebarCollection key={kind} kind={kind} newFolder={creating[kind]}
    {...kind === 'chat' ? { hidden: matchingHidden.map(botItem), search: !!search, sections: layout?.chat.folders ?? [], onBotUpdate: updateBot, onNewSection: newSection } : {}}
    items={kind === 'chat' ? matchingBots.map(botItem) : matchingRoutines.map(routine => ({ ...routine, active: routine.id === selectedRoutineId, content: <><span className="sidebar-routine-icon"><Repeat2 size={17} strokeWidth={1.6} aria-hidden /></span><span className="sidebar-routine-copy"><strong>{routine.name}</strong><small>{routine.task ? routine.task.surface === 'web' ? t('sidebar.routineBrowser') : t('sidebar.routineComet') : t('sidebar.routineSteps', { n: routine.steps.length })}{routine.lastOutcome && ` · ${routine.lastOutcome === 'done' ? t('sidebar.routineDone') : routine.lastOutcome === 'aborted' ? t('sidebar.routinePaused') : t('sidebar.routineAttention')}`}</small></span></> }))}
    layout={(kind === 'chat' ? matchingLayout : routineLayout) ?? { folders: [], items: (kind === 'chat' ? listed : routines).map(one => ({ id: one.id, folder: null })) }}
    onChange={async changeValue => { await change(kind, changeValue) }} onRename={(id, name) => rename(kind, id, name)} onRemove={id => remove(kind, id)} onError={showToast}
    onOpen={id => { if (kind === 'chat') openBot(id); else { onSelectRoutine(id); if (window.innerWidth <= 900) onToggle() } }} />
  return <aside className={`app-sidebar${open ? ' open' : ''}`} data-testid="app-sidebar" aria-hidden={!open}>
    <div className="app-sidebar-head"><WorkspaceSwitcher activity={activity} onNavigate={navigate} /><WorkspaceMode developer={developer} onChange={navigate} /><button className="sidebar-icon-button" data-testid="app-sidebar-close" title={t('rail.hide')} aria-label={t('rail.hide')} onClick={onToggle}><PanelLeftClose size={17} strokeWidth={1.8} aria-hidden /></button></div>
    {developer ? <div id="developer-sidebar" className="developer-sidebar-content" /> : <>
    <div className={`sidebar-library-tools${searchOpen ? ' searching' : ''}`}><button ref={searchToggle} className="sidebar-icon-button bots-top-button sidebar-search-toggle" data-testid="sidebar-search-toggle" aria-label={t('sidebar.searchButton')} title={t('sidebar.searchButton')} aria-expanded={searchOpen} aria-controls={searchId} onClick={() => { flushSync(() => setSearchOpen(true)); searchInput.current?.focus() }}><Search size={17} aria-hidden /></button>
    <div id={searchId} className={`sidebar-search${searchOpen ? ' open' : ''}`} {...searchOpen ? {} : { inert: '', 'aria-hidden': true }} onBlur={event => { if (!query && !composing.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) setSearchOpen(false) }}><Search size={14} aria-hidden /><input ref={searchInput} aria-label={library ? t('sidebar.searchRoutines') : t('sidebar.searchConversations')} placeholder={library ? t('sidebar.searchRoutines') : t('sidebar.searchConversations')} value={query} onChange={event => setQuery(event.target.value)} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false }} onKeyDown={event => {
      if (event.key !== 'Escape' || event.nativeEvent.isComposing || event.keyCode === 229) return
      // Stop here so the overlay's window Esc handler closes the sidebar only on the next press.
      event.stopPropagation()
      if (query) { event.preventDefault(); setQuery('') } else { flushSync(() => setSearchOpen(false)); searchToggle.current?.focus() }
    }} />{query && <button aria-label={t('sidebar.clearSearch')} onClick={() => { setQuery(''); searchInput.current?.focus() }}><X size={13} aria-hidden /></button>}</div>
    <button className={`sidebar-icon-button sidebar-create${library ? '' : ' bots-top-button'}`} data-testid="sidebar-create" aria-label={t('sidebar.create')} title={t('sidebar.create')} disabled={!vaultReady} {...{ popovertarget: createId }} onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); if (createMenu.current) Object.assign(createMenu.current.style, { left: `${Math.max(8, rect.right - 200)}px`, top: `${rect.bottom + 6}px` }) }}><Plus size={18} aria-hidden /></button></div>
    <div id={createId} ref={createMenu} {...{ popover: "auto" }} className="sidebar-create-menu" aria-label={t('sidebar.create')}>
      {!library && <button data-testid="bots-new" disabled={!vaultReady} onClick={() => { createMenu.current?.hidePopover(); setActivity('bots'); selectComet(null); setQuery(''); if (window.innerWidth <= 900) onToggle(); setCreatingBot(true) }}><Plus size={16} aria-hidden />{t('bots.new')}</button>}
      <button aria-label={library ? t('sidebar.newRoutineFolder') : t('sidebar.newSection')} onClick={() => { createMenu.current?.hidePopover(); newFolder(library ? 'routine' : 'chat') }}><FolderPlus size={16} aria-hidden />{library ? t('sidebar.newFolder') : t('sidebar.newSection')}</button>
    </div>
    {library && <button className="sidebar-new" onClick={() => navigate('bots')}><ArrowLeft size={17} aria-hidden /><span>{t('sidebar.conversations')}</span></button>}
    <div className="sidebar-scroll">
      {!library && hero && <SidebarPrimary bot={hero} activity={activityOf(hero)} active={hero.id === selectedId && (activity === 'bots' || activity === 'mission')} onOpen={openBot} />}
      {layoutError && <p className="sidebar-empty" role="alert">{layoutError}</p>}
      <section className="sidebar-section sidebar-conversations" aria-label={library ? t('sidebar.savedRoutines') : t('sidebar.conversations')}>
        {library && <h2 className="sidebar-library-title">{t('sidebar.routines')}</h2>}
        {library ? collection('routine') : <div role="tree" aria-label={t('sidebar.bots')} className="sidebar-bots-tree">{collection('chat')}</div>}
        {!(library ? matchingRoutines : [...matchingBots, ...matchingHidden]).length && <p className="sidebar-empty">{search ? t('sidebar.noMatches') : library ? t('sidebar.noRoutines') : t('sidebar.empty')}</p>}
      </section>
    </div>
    </>}
    <footer className="sidebar-footer">
      <SidebarStatus />
      {!library && !developer && <NoticesBell disabled={!vaultReady} onOpen={openBot} />}
      <button data-testid="activity-settings" aria-label={t('sidebar.settings')} title={t('sidebar.settings')} onClick={onOpenSettings}><Settings size={16} aria-hidden /><span>{t('sidebar.settings')}</span></button>
    </footer>
    {creatingBot && <CreateBotDialog onClose={() => setCreatingBot(false)} onCreated={bot => openBot(bot.id)} />}
  </aside>
}
