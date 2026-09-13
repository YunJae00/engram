import { ChevronDown, List, Orbit, PanelLeftClose, Play, Plus, Search, Settings } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BotDto, BotSuggestionDto, RoutineDto, SidebarLayout, SidebarKind, SidebarChange } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { cometThreads, loadCometThread, selectComet } from '../lib/cometThreadsLive.js'
import { cometOfChannel } from '../lib/cometThreads.js'
import { useCometActivity } from '../lib/useCometActivity.js'
import { useShellState } from '../state-slices.js'
import { BotSuggestions } from './BotSuggestions.js'
import { Comet, OrbitMark } from './Icon.js'
import { SidebarStatus } from './SidebarStatus.js'
import { SidebarDisclosure } from './SidebarDisclosure.js'
import { CometActivityIndicator } from './CometActivityIndicator.js'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js'
import { SidebarCollection } from './SidebarCollection.js'
import { SiteIcon } from './SiteIcon.js'

interface Props {
  open: boolean; onToggle(): void; onOpenPalette(): void; onOpenSettings(): void; onOpenRoutines(): void
}
const storedOpen = (key: string) => localStorage.getItem(key) !== '0'

export function AppSidebar({ open, onToggle, onOpenPalette, onOpenSettings, onOpenRoutines }: Props) {
  const { activity, setActivity, vaultReady, showToast } = useShellState()
  const [bots, setBots] = useState<BotDto[]>([])
  const [routines, setRoutines] = useState<RoutineDto[]>([])
  const [suggestions, setSuggestions] = useState<BotSuggestionDto[]>([])
  const [layout, setLayout] = useState<SidebarLayout | null>(null)
  const [layoutError, setLayoutError] = useState('')
  const [chatsOpen, setChatsOpen] = useState(() => storedOpen('engram.sidebar.chats'))
  const [routinesOpen, setRoutinesOpen] = useState(() => storedOpen('engram.sidebar.routines'))
  const [creating, setCreating] = useState({ chat: 0, routine: 0 })
  const selectedId = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.getSnapshot().selectedId)
  const activityOf = useCometActivity()
  const reload = async () => {
    if (!vaultReady) return
    const [nextBots, nextRoutines, nextSuggestions, nextLayout] = await Promise.all([
      api.botsList(), api.routinesList(), api.botsRecommend().catch(() => []),
      api.sidebarLayout().catch(error => { setLayoutError(String(error.message ?? error)); return null }),
    ])
    setBots(nextBots); setRoutines(nextRoutines); setSuggestions(nextSuggestions)
    if (nextLayout) { setLayout(nextLayout); setLayoutError('') }
    const current = cometThreads.getSnapshot().selectedId
    if (current && !nextBots.some(bot => bot.id === current)) selectComet(null)
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
      if (!['bots:changed', 'vault:changed', 'routine:logged'].includes(event.type)) return
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => void reload().catch(error => showToast(String(error))), 100)
    })
    return () => { window.clearTimeout(debounce); off() }
  }, [vaultReady])
  useEffect(() => localStorage.setItem('engram.sidebar.chats', chatsOpen ? '1' : '0'), [chatsOpen])
  useEffect(() => localStorage.setItem('engram.sidebar.routines', routinesOpen ? '1' : '0'), [routinesOpen])
  const navigate = (next: 'bots' | 'sky' | 'list' | 'mission') => { setActivity(next); if (window.innerWidth <= 900) onToggle() }
  const change = async (kind: SidebarKind, change: SidebarChange['change']) => { setLayout(await api.sidebarChange({ kind, change })) }
  const rename = async (kind: SidebarKind, id: string, name: string) => { if (kind === 'chat') await api.botRename(id, name); else await api.routineRename(id, name); await reload() }
  const remove = async (kind: SidebarKind, id: string) => { if (kind === 'chat') { await api.botDelete(id); cometThreads.forget(id) } else await api.routineRemove(id); await reload() }
  const newFolder = (kind: SidebarKind) => { if (kind === 'chat') setChatsOpen(true); else setRoutinesOpen(true); setCreating(current => ({ ...current, [kind]: current[kind] + 1 })) }
  const collection = (kind: SidebarKind) => <SidebarCollection kind={kind} newFolder={creating[kind]}
    items={kind === 'chat' ? bots.map(bot => ({ id: bot.id, name: bot.name, active: bot.id === selectedId && activity === 'bots', leading: <><CometActivityIndicator state={activityOf(bot)} />{bot.webSites?.[0] && <SiteIcon origin={bot.webSites[0].origin} />}</> })) : routines}
    layout={layout?.[kind] ?? { folders: [], items: (kind === 'chat' ? bots : routines).map(one => ({ id: one.id, folder: null })) }}
    onChange={changeValue => change(kind, changeValue)} onRename={(id, name) => rename(kind, id, name)} onRemove={id => remove(kind, id)} onError={showToast}
    onOpen={id => { if (kind === 'chat') { selectComet(id); navigate('bots') } else window.dispatchEvent(new CustomEvent('engram:run-routine', { detail: { routineId: id } })) }} />
  return <aside className={`app-sidebar${open ? ' open' : ''}`} data-testid="app-sidebar" aria-hidden={!open}>
    <div className="app-sidebar-head"><WorkspaceSwitcher /><button className="sidebar-icon-button" data-testid="app-sidebar-close" title={t('rail.hide')} onClick={onToggle}><PanelLeftClose size={17} strokeWidth={1.8} aria-hidden /></button></div>
    <nav className="sidebar-nav" aria-label={t('topbar.canvas')}>
      <button className={`sidebar-nav-row${activity === 'bots' ? ' active' : ''}`} data-testid="activity-bots" onClick={() => navigate('bots')}><Comet size={16} /><span>{t('topbar.tabBots')}</span></button>
      <button className={`sidebar-nav-row${activity === 'sky' ? ' active' : ''}`} data-testid="activity-sky" onClick={() => navigate('sky')}><Orbit size={16} strokeWidth={1.8} aria-hidden /><span>{t('topbar.tabSky')}</span></button>
      <button className={`sidebar-nav-row${activity === 'list' ? ' active' : ''}`} data-testid="activity-list" onClick={() => navigate('list')}><List size={16} strokeWidth={1.8} aria-hidden /><span>{t('activity.list')}</span></button>
      <button className={`sidebar-nav-row${activity === 'mission' ? ' active' : ''}`} data-testid="activity-mission" onClick={() => navigate('mission')}><OrbitMark size={16} /><span>{t('mission.title')}</span></button>
    </nav>
    <SidebarStatus />
    <div className="sidebar-scroll">
      {layoutError && <p className="sidebar-empty" role="alert">{layoutError}</p>}
      <section className="sidebar-section">
        <div className="sidebar-section-head">
          <button className="sidebar-section-toggle" data-testid="sidebar-routines-toggle" aria-expanded={routinesOpen} aria-controls="sidebar-routines-content" onClick={() => setRoutinesOpen(!routinesOpen)}><ChevronDown size={14} aria-hidden /><span>{t('bots.routinesTitle')}</span></button>
          <button className="sidebar-section-open" aria-label="New routine folder" title="New folder" onClick={() => newFolder('routine')}><Plus size={13} aria-hidden /></button>
          <button className="sidebar-section-open" title={t('sidebar.openRoutines')} onClick={onOpenRoutines}><Play size={13} strokeWidth={1.9} aria-hidden /></button>
        </div>
        <SidebarDisclosure id="sidebar-routines-content" open={routinesOpen}>{collection('routine')}{!routines.length && !layout?.routine.folders.length && <p className="sidebar-empty">{t('sidebar.noRoutines')}</p>}</SidebarDisclosure>
      </section>
      <section className="sidebar-section">
        <div className="sidebar-section-head">
          <button className="sidebar-section-toggle" data-testid="sidebar-chats-toggle" aria-expanded={chatsOpen} aria-controls="sidebar-chats-content" onClick={() => setChatsOpen(!chatsOpen)}><ChevronDown size={14} aria-hidden /><span>{t('sidebar.chats')}</span></button>
          <button className="sidebar-section-open" aria-label="New chat folder" title="New folder" onClick={() => newFolder('chat')}><Plus size={13} aria-hidden /></button>
        </div>
        <SidebarDisclosure id="sidebar-chats-content" open={chatsOpen}>
          {collection('chat')}{!bots.length && !layout?.chat.folders.length && <p className="sidebar-empty">{t('sidebar.noChats')}</p>}
          <button className="sidebar-new" data-testid="bots-new" disabled={!vaultReady} onClick={() => { setActivity('bots'); selectComet(null); setChatsOpen(true) }}><Plus size={15} strokeWidth={1.9} aria-hidden /><span>{t('bots.new')}</span></button>
          <BotSuggestions suggestions={suggestions} onCreate={(name, purpose) => { void api.botCreate({ name, purpose }).then(bot => { selectComet(bot.id); setActivity('bots'); void reload() }) }}
            onDismiss={name => { setSuggestions(items => items.filter(item => item.name !== name)); void api.botSuggestionDismiss(name).catch(() => undefined) }} />
        </SidebarDisclosure>
      </section>
    </div>
    <footer className="sidebar-footer">
      <button onClick={onOpenPalette} title={t('topbar.searchTitle')}><Search size={16} aria-hidden /><span>{t('sidebar.search')}</span></button>
      <button data-testid="activity-settings" onClick={onOpenSettings}><Settings size={16} aria-hidden /><span>{t('sidebar.settings')}</span></button>
    </footer>
  </aside>
}
