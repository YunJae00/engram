import { PanelLeftClose, Plus, Settings } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BotDto, SidebarLayout, SidebarChange } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { cometThreads, loadCometThread, selectComet } from '../lib/cometThreadsLive.js'
import { cometOfChannel } from '../lib/cometThreads.js'
import { useCometActivity } from '../lib/useCometActivity.js'
import { useShellState } from '../state-slices.js'
import { SidebarStatus } from './SidebarStatus.js'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js'
import { SidebarCollection } from './SidebarCollection.js'
import { SidebarBotTeam, SidebarConversation } from './SidebarConversation.js'
import { watchAccountUsage } from '../lib/accountUsage.js'
import { WorkspaceMode } from './WorkspaceMode.js'
import { SidebarPrimary } from './SidebarPrimary.js'
import { groupSidebarBots } from '../lib/sidebarBots.js'
import { CreateBotDialog } from './CreateBotDialog.js'

interface Props {
  developer: boolean
  open: boolean; onToggle(): void; onOpenSettings(): void
}

// The team list, one way to add a bot, and Settings. Everything else about a bot is asked for in chat.
export function AppSidebar({ developer, open, onToggle, onOpenSettings }: Props) {
  const { activity, setActivity, vaultReady, showToast } = useShellState()
  useEffect(() => { if (vaultReady) return watchAccountUsage() }, [vaultReady])
  const [bots, setBots] = useState<BotDto[]>([])
  const [layout, setLayout] = useState<SidebarLayout | null>(null)
  const [layoutError, setLayoutError] = useState('')
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
    const [nextBots, nextLayout] = await Promise.all([
      api.botsList(),
      api.sidebarLayout('chat').catch(error => { setLayoutError(String(error.message ?? error)); return null }),
    ])
    if (generation !== reloadGeneration.current) return
    setBots(nextBots)
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
      if (!['bots:changed', 'routine:logged', 'chat:done', 'chat:error'].includes(event.type)) return
      reloadGeneration.current++
      window.clearTimeout(debounce)
      debounce = window.setTimeout(() => void reload().catch(error => showToast(String(error))), 100)
    })
    return () => { reloadGeneration.current++; window.clearTimeout(debounce); off() }
  }, [vaultReady])
  const navigate = (next: 'bots' | 'developers' | 'sky' | 'list') => { setActivity(next); if (window.innerWidth <= 900) onToggle() }
  const change = async (change: SidebarChange['change']) => { setLayout(await api.sidebarChange({ kind: 'chat', change })) }
  const live = (bot: BotDto) => waiting.has(bot.id) || ['running', 'waiting'].includes(activityOf(bot))
  const { hero, listed, hidden } = groupSidebarBots(bots)
  const shown = (bot: BotDto) => bot.id === selectedId && activity === 'bots'
  const botItem = (bot: BotDto) => ({ id: bot.id, name: bot.name, active: shown(bot), recency: live(bot) ? Number.MAX_SAFE_INTEGER : Date.parse(bot.lastMessage?.at ?? bot.createdAt), content: <SidebarConversation bot={bot} state={activityOf(bot)} active={shown(bot)} />, below: <SidebarBotTeam bot={bot} /> })
  const openBot = (id: string) => { selectComet(id); navigate('bots') }
  return <aside className={`app-sidebar${open ? ' open' : ''}`} data-testid="app-sidebar" aria-hidden={!open}>
    <div className="app-sidebar-head"><WorkspaceSwitcher activity={activity} onNavigate={navigate} /><WorkspaceMode developer={developer} onChange={navigate} /><button className="sidebar-icon-button" data-testid="app-sidebar-close" title={t('rail.hide')} aria-label={t('rail.hide')} onClick={onToggle}><PanelLeftClose size={17} strokeWidth={1.8} aria-hidden /></button></div>
    {developer ? <div id="developer-sidebar" className="developer-sidebar-content" /> : <>
    <div className="sidebar-library-tools"><button className="sidebar-icon-button sidebar-create bots-top-button" data-testid="sidebar-create" aria-label={t('sidebar.create')} title={t('sidebar.create')} disabled={!vaultReady} onClick={() => setCreatingBot(true)}><Plus size={18} aria-hidden /></button></div>
    <div className="sidebar-scroll">
      {hero && <SidebarPrimary bot={hero} activity={activityOf(hero)} active={shown(hero)} onOpen={openBot} />}
      {layoutError && <p className="sidebar-empty" role="alert">{layoutError}</p>}
      <section className="sidebar-section sidebar-conversations" aria-label={t('sidebar.conversations')}>
        <div role="tree" aria-label={t('sidebar.bots')} className="sidebar-bots-tree"><SidebarCollection items={listed.map(botItem)} hidden={hidden.map(botItem)}
          layout={layout?.chat ?? { folders: [], items: listed.map(one => ({ id: one.id, folder: null })) }}
          onChange={change} onError={showToast} onOpen={openBot} /></div>
        {!(listed.length + hidden.length) && <p className="sidebar-empty">{t('sidebar.empty')}</p>}
      </section>
    </div>
    </>}
    <footer className="sidebar-footer">
      <SidebarStatus />
      <button data-testid="activity-settings" aria-label={t('sidebar.settings')} title={t('sidebar.settings')} onClick={onOpenSettings}><Settings size={16} aria-hidden /><span>{t('sidebar.settings')}</span></button>
    </footer>
    {creatingBot && <CreateBotDialog onClose={() => setCreatingBot(false)} onCreated={bot => openBot(bot.id)} />}
  </aside>
}
