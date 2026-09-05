import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  List,
  PanelsTopLeft,
  MoreHorizontal,
  Orbit,
  PanelLeftClose,
  Play,
  Plus,
  Search,
  Settings,
  Trash2,
} from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BotDto, BotSuggestionDto, RoutineDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { cometThreads, selectComet } from '../lib/cometThreadsLive.js'
import { useShellState } from '../state-slices.js'
import { BotSuggestions } from './BotSuggestions.js'
import { Comet } from './Icon.js'
import { SidebarStatus } from './SidebarStatus.js'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js'

type Menu = { kind: 'chat' | 'routine'; id: string } | null
type Editing = { kind: 'chat' | 'routine'; id: string; name: string } | null

interface Props {
  open: boolean
  onToggle(): void
  onOpenPalette(): void
  onOpenSettings(): void
  onOpenRoutines(): void
}

function storedOpen(key: string): boolean {
  return localStorage.getItem(key) !== '0'
}

export function AppSidebar({ open, onToggle, onOpenPalette, onOpenSettings, onOpenRoutines }: Props) {
  const { activity, setActivity, vaultReady, showToast } = useShellState()
  const [bots, setBots] = useState<BotDto[]>([])
  const [routines, setRoutines] = useState<RoutineDto[]>([])
  const [suggestions, setSuggestions] = useState<BotSuggestionDto[]>([])
  const [chatsOpen, setChatsOpen] = useState(() => storedOpen('engram.sidebar.chats'))
  const [routinesOpen, setRoutinesOpen] = useState(() => storedOpen('engram.sidebar.routines'))
  const [menu, setMenu] = useState<Menu>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const { selectedId } = useSyncExternalStore(cometThreads.subscribe, cometThreads.getSnapshot)
  const reload = async () => {
    if (!vaultReady) return
    const [nextBots, nextRoutines, nextSuggestions] = await Promise.all([
      api.botsList(),
      api.routinesList(),
      api.botsRecommend().catch(() => []),
    ])
    setBots(nextBots)
    setRoutines(nextRoutines)
    setSuggestions(nextSuggestions)
    const current = cometThreads.getSnapshot().selectedId
    if (!nextBots.some((bot) => bot.id === current)) selectComet(nextBots[0]?.id ?? null)
  }

  useEffect(() => {
    void reload()
    if (!vaultReady) return
    let debounce: number | null = null
    const unsubscribe = api.onEvent((event) => {
      if (event.type === 'bots:changed') void reload()
      if (event.type !== 'vault:changed' && event.type !== 'routine:logged') return
      if (debounce !== null) window.clearTimeout(debounce)
      debounce = window.setTimeout(() => {
        debounce = null
        void reload()
      }, 180)
    })
    return () => {
      if (debounce !== null) window.clearTimeout(debounce)
      unsubscribe()
    }
  }, [vaultReady])

  useEffect(() => localStorage.setItem('engram.sidebar.chats', chatsOpen ? '1' : '0'), [chatsOpen])
  useEffect(() => localStorage.setItem('engram.sidebar.routines', routinesOpen ? '1' : '0'), [routinesOpen])

  useEffect(() => {
    if (!menu) return
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenu(null)
        setConfirming(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMenu(null)
        setConfirming(null)
      }
    }
    window.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [menu])

  const navigate = (next: 'bots' | 'sky' | 'list' | 'mission') => {
    setActivity(next)
    if (window.innerWidth <= 900) onToggle()
  }

  const createComet = async () => {
    const bot = await api.botCreate({ name: t('bots.untitled'), purpose: '' }).catch(() => null)
    if (!bot) return
    setActivity('bots')
    selectComet(bot.id)
    setChatsOpen(true)
    await reload()
  }

  const openMenu = (kind: 'chat' | 'routine', id: string) => {
    setMenu((current) => (current?.kind === kind && current.id === id ? null : { kind, id }))
    setConfirming(null)
  }

  const beginRename = (kind: 'chat' | 'routine', id: string, name: string) => {
    setEditing({ kind, id, name })
    setMenu(null)
    setConfirming(null)
  }

  const commitRename = async () => {
    if (!editing) return
    const current = editing
    const name = current.name.trim()
    setEditing(null)
    if (!name) return
    try {
      if (current.kind === 'chat') await api.botRename(current.id, name)
      else await api.routineRename(current.id, name)
      await reload()
    } catch (error) {
      showToast(String((error as Error).message ?? error))
    }
  }

  const remove = async (kind: 'chat' | 'routine', id: string) => {
    const key = `${kind}:${id}`
    if (confirming !== key) {
      setConfirming(key)
      return
    }
    if (kind === 'chat') {
      await api.botDelete(id)
      cometThreads.forget(id)
    } else {
      await api.routineRemove(id)
    }
    setMenu(null)
    setConfirming(null)
    await reload()
  }

  const dismissSuggestion = async (name: string) => {
    setSuggestions((items) => items.filter((item) => item.name !== name))
    await api.botSuggestionDismiss(name).catch(() => undefined)
  }

  return (
    <aside className={`app-sidebar${open ? ' open' : ''}`} data-testid="app-sidebar" aria-hidden={!open}>
      <div className="app-sidebar-head">
        <WorkspaceSwitcher />
        <button className="sidebar-icon-button" data-testid="app-sidebar-close" title={t('rail.hide')} onClick={onToggle}>
          <PanelLeftClose size={17} strokeWidth={1.8} aria-hidden />
        </button>
      </div>

      <nav className="sidebar-nav" aria-label={t('topbar.canvas')}>
        <button className={`sidebar-nav-row${activity === 'bots' ? ' active' : ''}`} data-testid="activity-bots" onClick={() => navigate('bots')}>
          <Comet size={16} />
          <span>{t('topbar.tabBots')}</span>
        </button>
        <button className={`sidebar-nav-row${activity === 'sky' ? ' active' : ''}`} data-testid="activity-sky" onClick={() => navigate('sky')}>
          <Orbit size={16} strokeWidth={1.8} aria-hidden />
          <span>{t('topbar.tabSky')}</span>
        </button>
        <button className={`sidebar-nav-row${activity === 'list' ? ' active' : ''}`} data-testid="activity-list" onClick={() => navigate('list')}>
          <List size={16} strokeWidth={1.8} aria-hidden />
          <span>{t('activity.list')}</span>
        </button>
        <button className={`sidebar-nav-row${activity === 'mission' ? ' active' : ''}`} data-testid="activity-mission" onClick={() => navigate('mission')}>
          <PanelsTopLeft size={16} strokeWidth={1.8} aria-hidden />
          <span>{t('mission.title')}</span>
        </button>
      </nav>

      <SidebarStatus />

      <div className="sidebar-scroll">
        <section className="sidebar-section">
          <div className="sidebar-section-head">
            <button className="sidebar-section-toggle" data-testid="sidebar-routines-toggle" onClick={() => setRoutinesOpen(!routinesOpen)}>
              {routinesOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              <span>{t('bots.routinesTitle')}</span>
            </button>
            <button className="sidebar-section-open" title={t('sidebar.openRoutines')} onClick={onOpenRoutines}>
              <Play size={13} strokeWidth={1.9} aria-hidden />
            </button>
          </div>
          {routinesOpen && (
            <ul className="sidebar-list" data-testid="sidebar-routines">
              {routines.map((routine) => (
                <li className="sidebar-item" key={routine.id}>
                  {editing?.kind === 'routine' && editing.id === routine.id ? (
                    <input
                      className="sidebar-rename"
                      data-testid={`sidebar-routine-name-${routine.id}`}
                      autoFocus
                      maxLength={80}
                      value={editing.name}
                      onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                      onBlur={() => void commitRename()}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') event.currentTarget.blur()
                        if (event.key === 'Escape') setEditing(null)
                      }}
                    />
                  ) : (
                    <button
                      className="sidebar-item-main"
                      title={routine.name}
                      data-testid={`sidebar-routine-run-${routine.id}`}
                      onClick={() =>
                        // The comets view owns the run: it knows which comet
                        // keeps this routine and runs it there as a turn.
                        window.dispatchEvent(new CustomEvent('engram:run-routine', { detail: { routineId: routine.id } }))
                      }
                    >
                      <span>{routine.name}</span>
                    </button>
                  )}
                  <button className="sidebar-more" data-testid={`sidebar-routine-menu-${routine.id}`} title={t('sidebar.more')} onClick={() => openMenu('routine', routine.id)}>
                    <MoreHorizontal size={15} aria-hidden />
                  </button>
                  {menu?.kind === 'routine' && menu.id === routine.id && (
                    <div className="sidebar-menu" ref={menuRef}>
                      <button data-testid={`sidebar-routine-rename-${routine.id}`} onClick={() => beginRename('routine', routine.id, routine.name)}>{t('sidebar.rename')}</button>
                      <button className={confirming === `routine:${routine.id}` ? 'danger' : ''} onClick={() => void remove('routine', routine.id)}>
                        <Trash2 size={13} aria-hidden />
                        {confirming === `routine:${routine.id}` ? t('sidebar.deleteConfirm') : t('sidebar.delete')}
                      </button>
                    </div>
                  )}
                </li>
              ))}
              {routines.length === 0 && <li className="sidebar-empty">{t('sidebar.noRoutines')}</li>}
            </ul>
          )}
        </section>

        <section className="sidebar-section">
          <div className="sidebar-section-head">
            <button className="sidebar-section-toggle" data-testid="sidebar-chats-toggle" onClick={() => setChatsOpen(!chatsOpen)}>
              {chatsOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
              <span>{t('sidebar.chats')}</span>
            </button>
          </div>
          {chatsOpen && (
            <>
              <ul className="sidebar-list" data-testid="sidebar-chats">
                {bots.map((bot) => (
                  <li className={`sidebar-item${bot.id === selectedId && activity === 'bots' ? ' active' : ''}`} key={bot.id}>
                    {editing?.kind === 'chat' && editing.id === bot.id ? (
                      <input
                        className="sidebar-rename"
                        data-testid={`sidebar-chat-name-${bot.id}`}
                        autoFocus
                        maxLength={80}
                        value={editing.name}
                        onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                        onBlur={() => void commitRename()}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur()
                          if (event.key === 'Escape') setEditing(null)
                        }}
                      />
                    ) : (
                      <button
                        className={`sidebar-item-main bots-row${bot.id === selectedId && activity === 'bots' ? ' active' : ''}`}
                        data-testid={`bot-${bot.id}`}
                        title={bot.name}
                        onClick={() => {
                          selectComet(bot.id)
                          navigate('bots')
                        }}
                      >
                        <span>{bot.name}</span>
                      </button>
                    )}
                    <button className="sidebar-more" data-testid={`sidebar-chat-menu-${bot.id}`} title={t('sidebar.more')} onClick={() => openMenu('chat', bot.id)}>
                      <MoreHorizontal size={15} aria-hidden />
                    </button>
                    {menu?.kind === 'chat' && menu.id === bot.id && (
                      <div className="sidebar-menu" ref={menuRef}>
                        <button data-testid={`sidebar-chat-rename-${bot.id}`} onClick={() => beginRename('chat', bot.id, bot.name)}>{t('sidebar.rename')}</button>
                        <button className={confirming === `chat:${bot.id}` ? 'danger' : ''} onClick={() => void remove('chat', bot.id)}>
                          <Trash2 size={13} aria-hidden />
                          {confirming === `chat:${bot.id}` ? t('sidebar.deleteConfirm') : t('sidebar.delete')}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
                {bots.length === 0 && <li className="sidebar-empty">{t('sidebar.noChats')}</li>}
              </ul>
              <button className="sidebar-new" data-testid="bots-new" disabled={!vaultReady} onClick={() => void createComet()}>
                <Plus size={15} strokeWidth={1.9} aria-hidden />
                <span>{t('bots.new')}</span>
              </button>
              <BotSuggestions
                suggestions={suggestions}
                onCreate={(name, purpose) => {
                  void api.botCreate({ name, purpose }).then((bot) => {
                    selectComet(bot.id)
                    setActivity('bots')
                    void reload()
                  })
                }}
                onDismiss={(name) => void dismissSuggestion(name)}
              />
            </>
          )}
        </section>
      </div>

      <footer className="sidebar-footer">
        <button onClick={onOpenPalette} title={t('topbar.searchTitle')}><Search size={16} aria-hidden /><span>{t('sidebar.search')}</span></button>
        <button data-testid="help-button" onClick={() => window.dispatchEvent(new Event('engram:open-help'))}><CircleHelp size={16} aria-hidden /><span>{t('help.open')}</span></button>
        <button data-testid="activity-settings" onClick={onOpenSettings}><Settings size={16} aria-hidden /><span>{t('sidebar.settings')}</span></button>
      </footer>
    </aside>
  )
}
