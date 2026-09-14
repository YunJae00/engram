import { ArrowUpRight, ChevronDown, PanelRight, Plus } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BotDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { MiniChat } from '../components/MiniChat.js'
import { CometActivityIndicator, cometActivityLabel } from '../components/CometActivityIndicator.js'
import { OrbitSurface } from '../components/OrbitSurface.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, selectComet } from '../lib/cometThreadsLive.js'
import { useCometActivity } from '../lib/useCometActivity.js'
import { fillSeats, readSeats, replaceSeat } from '../lib/missionSeats.js'
import { useShellState } from '../state-slices.js'
import { SidebarDisclosure } from '../components/SidebarDisclosure.js'

const SEATS_KEY = 'engram.mission.slots'
const FOLDED_KEY = 'engram.mission.folded-chats'

function readFoldedChats(): Set<string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch { return new Set() }
}

export function MissionControl({ layout }: { layout: 2 | 4 }) {
  const { setActivity } = useShellState()
  const activityOf = useCometActivity()
  const [bots, setBots] = useState<BotDto[]>([])
  const [active, setActive] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [seats, setSeats] = useState(() => {
    const saved = readSeats(localStorage.getItem(SEATS_KEY))
    const selected = cometThreads.getSnapshot().selectedId
    return selected ? replaceSeat(saved, 0, selected) : saved
  })
  const [adding, setAdding] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [foldedChats, setFoldedChats] = useState(readFoldedChats)
  const [pages, setPages] = useState<Set<string>>(() => new Set())
  const [openedPages, setOpenedPages] = useState<Set<string>>(() => new Set())
  const [hiddenPages, setHiddenPages] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState(false)

  useEffect(() => {
    if (adding === null) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Element && !event.target.closest('.mission-chooser, .mission-change, .mission-add')) setAdding(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAdding(null)
      document.querySelector<HTMLElement>(`[data-testid="mission-tile-${adding}"] .mission-change, [data-testid="mission-add-${adding}"]`)?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', dismiss); document.removeEventListener('keydown', escape) }
  }, [adding])

  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      try {
        const [nextBots, nextActive] = await Promise.all([api.botsList(), api.chatActive()])
        if (!alive) return
        setBots(nextBots)
        setActive(nextActive)
        setLoaded(true)
        setError(false)
      } catch { if (alive) setError(true) }
      if (alive) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [])
  useEffect(() => localStorage.setItem(SEATS_KEY, JSON.stringify(seats)), [seats])
  useEffect(() => { if (loaded && seats[0]) selectComet(seats[0]) }, [loaded, seats[0]])
  useEffect(() => localStorage.setItem(FOLDED_KEY, JSON.stringify([...foldedChats])), [foldedChats])
  const statusOf = (bot: BotDto) => activityOf(bot, active.includes(cometChannel(bot.id)))
  const running = bots.filter((bot) => ['running', 'waiting'].includes(statusOf(bot))).map((bot) => bot.id)
  const runningKey = running.join('|')
  useEffect(() => {
    if (loaded) setSeats((previous) => fillSeats(previous, bots.map((bot) => bot.id), runningKey.split('|')))
  }, [bots, loaded, runningKey])

  const watched = seats.slice(0, layout).filter((id): id is string => id !== null).map(cometChannel).join('|')
  useEffect(() => {
    const renew = () => void api.missionWatch(document.visibilityState === 'visible' && watched ? watched.split('|') : []).catch(() => setError(true))
    renew()
    const timer = setInterval(renew, 4000)
    document.addEventListener('visibilitychange', renew)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', renew)
      void api.missionWatch([]).catch(() => undefined)
    }
  }, [watched])

  const open = (id: string) => { selectComet(id); setActivity('bots') }
  const seat = (index: number, id: string) => { setSeats((previous) => replaceSeat(previous, index, id)); setAdding(null) }
  const fresh = async (index: number) => {
    setCreating(true)
    try {
      const bot = await api.botCreate({ name: t('bots.untitled'), purpose: '' })
      setBots((previous) => [...previous.filter((one) => one.id !== bot.id), bot])
      seat(index, bot.id)
    } catch { setError(true) } finally { setCreating(false) }
  }
  const chooser = (index: number) => (
    <div className="mission-chooser">
      <SidebarDisclosure id={`mission-choices-${index}`} open={adding === index} unmountOnExit>
        <div className="mission-add-menu" data-testid={adding === index ? 'mission-add-menu' : undefined} aria-label="Choose a comet">
          <button className="mission-add-new" disabled={creating} onClick={() => void fresh(index)}><Plus size={13} aria-hidden /> {t('mission.new')}</button>
          {bots.filter((bot) => bot.id !== seats[index]).map((bot) => <button key={bot.id} onClick={() => seat(index, bot.id)}>{bot.name}</button>)}
          <button className="mission-add-cancel" onClick={() => setAdding(null)}>{t('routines.submitCancel')}</button>
        </div>
      </SidebarDisclosure>
    </div>
  )

  return (
    <section className="mission-control" data-testid="mission-control" aria-label="Split conversations">
      {error && <p className="mission-error" role="status">{t('mission.error')}</p>}
      <div className={`mission-grid mission-grid-${layout}`}>
        {seats.slice(0, layout).map((id, index) => {
          const bot = bots.find((item) => item.id === id)
          const webOpen = Boolean(id && !hiddenPages.has(id) && (pages.has(id) || openedPages.has(id)))
          const chatFolded = Boolean(id && webOpen && foldedChats.has(id))
          if (!bot) return (
            <article className="mission-tile mission-open-seat" key={index} data-testid={`mission-tile-${index}`}>
              <button className="mission-add" data-testid={`mission-add-${index}`} aria-label={t('mission.add')} aria-expanded={adding === index} onClick={() => setAdding(adding === index ? null : index)}><Plus size={22} strokeWidth={1.6} aria-hidden /><span>{t('mission.add')}</span></button>
              {chooser(index)}
            </article>
          )
          return (
            <article className="mission-tile" data-state={statusOf(bot)} key={index} data-testid={`mission-tile-${index}`}>
              <header className="mission-tile-head">
                <button className="mission-name mission-change" title={t('mission.change')} aria-label={t('mission.choose', { count: index + 1 })} aria-expanded={adding === index} onClick={() => setAdding(adding === index ? null : index)}><span>{bot.name}</span><ChevronDown size={13} /></button>
                <span className="mission-status" role="status"><CometActivityIndicator state={statusOf(bot)} />{cometActivityLabel(statusOf(bot))}</span>
                <button className="mission-chat-toggle" data-testid={`mission-chat-toggle-${index}`} disabled={!webOpen} title={chatFolded ? 'Show conversation' : 'Hide conversation'} aria-label={chatFolded ? 'Show conversation' : 'Hide conversation'} aria-expanded={!chatFolded} aria-controls={`mission-chat-${index}`} onClick={() => setFoldedChats((previous) => {
                  const next = new Set(previous)
                  if (next.has(bot.id)) next.delete(bot.id)
                  else next.add(bot.id)
                  return next
                })}><PanelRight size={15} strokeWidth={1.7} aria-hidden /></button>
                <button className="mission-enter" aria-label={t('mission.open', { name: bot.name })} title={t('mission.open', { name: bot.name })} onClick={() => open(bot.id)}><ArrowUpRight size={15} aria-hidden /></button>
              </header>
              {chooser(index)}
              <div className="mission-tile-body" key={bot.id} data-chat-open={!chatFolded} data-web-open={webOpen}>
                <OrbitSurface lane={cometChannel(bot.id)} name={bot.name} open={() => open(bot.id)} onLiveChange={live => setPages(previous => { if (previous.has(bot.id) === live) return previous; const next = new Set(previous); if (live) next.add(bot.id); else next.delete(bot.id); return next })} />
                <div className="mission-chat-slot" id={`mission-chat-${index}`} aria-hidden={chatFolded} ref={(node) => { if (node) node.inert = chatFolded }}><MiniChat botId={bot.id} webOpen={webOpen} onToggleWeb={() => {
                  setHiddenPages(previous => { const next = new Set(previous); if (webOpen) next.add(bot.id); else next.delete(bot.id); return next })
                  if (!webOpen) setOpenedPages(previous => new Set(previous).add(bot.id))
                }} /></div>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
