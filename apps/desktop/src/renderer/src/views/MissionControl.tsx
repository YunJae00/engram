import { ArrowUpRight, ChevronDown, Columns2, Grid2X2, Monitor, Plus } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BotDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { MiniChat } from '../components/MiniChat.js'
import { MissionPreview } from '../components/MissionPreview.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, selectComet } from '../lib/cometThreadsLive.js'
import { fillSeats, readSeats, replaceSeat } from '../lib/missionSeats.js'
import { useShellState } from '../state-slices.js'

type Layout = 1 | 2 | 4
const SEATS_KEY = 'engram.mission.slots'

export function MissionControl() {
  const { setActivity } = useShellState()
  const { threads } = useSyncExternalStore(cometThreads.subscribe, cometThreads.getSnapshot)
  const [bots, setBots] = useState<BotDto[]>([])
  const [active, setActive] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [seats, setSeats] = useState(() => readSeats(localStorage.getItem(SEATS_KEY)))
  const [adding, setAdding] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [layout, setLayout] = useState<Layout>(() => {
    const saved = Number(localStorage.getItem('engram.mission.layout'))
    return saved === 1 || saved === 2 ? saved : 4
  })
  const [error, setError] = useState(false)

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
  useEffect(() => localStorage.setItem('engram.mission.layout', String(layout)), [layout])
  useEffect(() => localStorage.setItem(SEATS_KEY, JSON.stringify(seats)), [seats])
  const isRunning = (id: string) => Boolean(threads[id]?.busy) || active.includes(cometChannel(id))
  const running = bots.filter((bot) => isRunning(bot.id)).map((bot) => bot.id)
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
    <div className="mission-add-menu" data-testid="mission-add-menu">
      <button className="mission-add-new" disabled={creating} onClick={() => void fresh(index)}><Plus size={13} aria-hidden /> {t('mission.new')}</button>
      {bots.filter((bot) => bot.id !== seats[index]).map((bot) => <button key={bot.id} onClick={() => seat(index, bot.id)}>{bot.name}</button>)}
      <button className="mission-add-cancel" onClick={() => setAdding(null)}>{t('routines.submitCancel')}</button>
    </div>
  )

  return (
    <section className="mission-control" data-testid="mission-control">
      <header className="mission-head">
        <div><h1>{t('mission.title')}</h1><p>{t('mission.summary', { count: running.length })}</p></div>
        <div className="mission-actions"><div className="mission-layout" aria-label={t('mission.layout')}>
          {([1, 2, 4] as const).map((count) => {
            const Icon = count === 1 ? Monitor : count === 2 ? Columns2 : Grid2X2
            return <button key={count} aria-pressed={layout === count} aria-label={t('mission.panels', { count })} data-testid={`mission-layout-${count}`} onClick={() => setLayout(count)}><Icon size={16} /><span>{count}</span></button>
          })}
        </div></div>
      </header>
      {error && <p className="mission-error" role="status">{t('mission.error')}</p>}
      <div className={`mission-grid mission-grid-${layout}`}>
        {seats.slice(0, layout).map((id, index) => {
          const bot = bots.find((item) => item.id === id)
          if (!bot) return (
            <article className="mission-tile mission-open-seat" key={index} data-testid={`mission-tile-${index}`}>
              {adding === index ? chooser(index) : <button className="mission-add" data-testid={`mission-add-${index}`} aria-label={t('mission.add')} onClick={() => setAdding(index)}><Plus size={22} strokeWidth={1.6} aria-hidden /><span>{t('mission.add')}</span></button>}
            </article>
          )
          return (
            <article className={`mission-tile${isRunning(bot.id) ? ' working' : ''}`} key={index} data-testid={`mission-tile-${index}`}>
              <header className="mission-tile-head">
                <span className="mission-number">{String(index + 1).padStart(2, '0')}</span>
                <button className="mission-name mission-change" title={t('mission.change')} aria-label={t('mission.choose', { count: index + 1 })} aria-expanded={adding === index} onClick={() => setAdding(adding === index ? null : index)}><span>{bot.name}</span><ChevronDown size={13} /></button>
                <span className="mission-status"><i />{t(isRunning(bot.id) ? 'mission.working' : 'mission.ready')}</span>
                <button className="mission-enter" aria-label={t('mission.open', { name: bot.name })} onClick={() => open(bot.id)}>{t('mission.enter')}<ArrowUpRight size={14} aria-hidden /></button>
              </header>
              {adding === index && chooser(index)}
              <div className="mission-tile-body" key={bot.id}>
                <MissionPreview lane={cometChannel(bot.id)} name={bot.name} open={() => open(bot.id)} />
                <MiniChat botId={bot.id} />
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
