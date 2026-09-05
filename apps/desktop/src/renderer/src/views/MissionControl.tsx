import { ArrowUpRight, Columns2, Grid2X2, Monitor, Plus } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BotDto, MissionFrameDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { MiniChat } from '../components/MiniChat.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, selectComet } from '../lib/cometThreadsLive.js'
import { useShellState } from '../state-slices.js'

type Layout = 1 | 2 | 4

// Every panel is a working seat: the page on one side, the conversation on
// the other, so a person runs several comets from here without leaving.
// What is RUNNING takes the front seats on its own; an empty seat is a
// plus - pick a chat, or start a new one on the spot.
export function MissionControl() {
  const { setActivity } = useShellState()
  const { threads } = useSyncExternalStore(cometThreads.subscribe, cometThreads.getSnapshot)
  const [bots, setBots] = useState<BotDto[]>([])
  const [active, setActive] = useState<string[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [adding, setAdding] = useState<number | null>(null)
  const [layout, setLayout] = useState<Layout>(() => {
    const saved = Number(localStorage.getItem('engram.mission.layout'))
    return saved === 1 || saved === 2 ? saved : 4
  })
  const [frames, setFrames] = useState<Record<string, MissionFrameDto>>({})
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
        setError(false)
      } catch {
        if (alive) setError(true)
      }
      if (alive) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => localStorage.setItem('engram.mission.layout', String(layout)), [layout])

  const isRunning = (id: string) => Boolean(threads[id]?.busy) || active.includes(cometChannel(id))
  // The seats fill themselves: running comets first, then whatever the
  // person pinned by hand, and nothing else - the rest are open seats.
  const running = bots.filter((bot) => isRunning(bot.id)).map((bot) => bot.id)
  const seats: (string | null)[] = []
  for (const id of [...running, ...picked.filter((id) => !running.includes(id) && bots.some((bot) => bot.id === id))]) {
    if (seats.length < layout && !seats.includes(id)) seats.push(id)
  }
  while (seats.length < layout) seats.push(null)

  const lanes = seats.filter((id): id is string => id !== null).map(cometChannel)
  const watched = lanes.join('|')
  useEffect(() => {
    if (!watched) return
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const refresh = async () => {
      if (document.visibilityState === 'visible') {
        try {
          const next = await api.missionFrames(watched.split('|'))
          if (!alive) return
          setFrames((previous) => {
            const merged: Record<string, MissionFrameDto> = {}
            for (const frame of next) merged[frame.lane] = frame.data ? frame : { ...previous[frame.lane], ...frame }
            // A poll that brought nothing new keeps the previous state, so a
            // quiet grid does not repaint once a second.
            const lanes = Object.keys(merged)
            const same =
              lanes.length === Object.keys(previous).length &&
              lanes.every((lane) => {
                const before = previous[lane]
                const after = merged[lane]!
                return before !== undefined && before.data === after.data && before.url === after.url && before.on === after.on && before.at === after.at
              })
            return same ? previous : merged
          })
        } catch {
          if (alive) setError(true)
        }
      }
      if (alive) timer = setTimeout(() => void refresh(), 1000)
    }
    void refresh()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [watched])

  const open = (id: string) => {
    selectComet(id)
    setActivity('bots')
  }
  const seat = (index: number, id: string) => {
    setPicked((previous) => [...previous.filter((one) => one !== id), id])
    setAdding(null)
    void index
  }
  const fresh = async () => {
    const bot = await api.botCreate({ name: t('bots.untitled'), purpose: '' }).catch(() => null)
    if (bot) seat(0, bot.id)
  }
  const spare = bots.filter((bot) => !seats.includes(bot.id))

  return (
    <section className="mission-control" data-testid="mission-control">
      <header className="mission-head">
        <div>
          <h1>{t('mission.title')}</h1>
          <p>{t('mission.summary', { count: running.length })}</p>
        </div>
        <div className="mission-actions">
          <div className="mission-layout" aria-label={t('mission.layout')}>
            {([1, 2, 4] as const).map((count) => {
              const Icon = count === 1 ? Monitor : count === 2 ? Columns2 : Grid2X2
              return (
                <button
                  key={count}
                  aria-pressed={layout === count}
                  aria-label={t('mission.panels', { count })}
                  data-testid={`mission-layout-${count}`}
                  onClick={() => setLayout(count)}
                >
                  <Icon size={16} />
                  <span>{count}</span>
                </button>
              )
            })}
          </div>
        </div>
      </header>
      {error && <p className="mission-error" role="status">{t('mission.error')}</p>}
      <div className={`mission-grid mission-grid-${layout}`}>
        {seats.map((id, index) => {
          const bot = bots.find((item) => item.id === id)
          if (!bot)
            return (
              <article className="mission-tile mission-open-seat" key={`open-${index}`} data-testid={`mission-tile-${index}`}>
                {adding === index ? (
                  <div className="mission-add-menu" data-testid="mission-add-menu">
                    <button className="mission-add-new" onClick={() => void fresh()}>
                      <Plus size={13} aria-hidden /> {t('mission.new')}
                    </button>
                    {spare.map((one) => (
                      <button key={one.id} onClick={() => seat(index, one.id)}>
                        {one.name}
                      </button>
                    ))}
                    <button className="mission-add-cancel" onClick={() => setAdding(null)}>
                      {t('routines.submitCancel')}
                    </button>
                  </div>
                ) : (
                  <button className="mission-add" data-testid={`mission-add-${index}`} aria-label={t('mission.add')} onClick={() => setAdding(index)}>
                    <Plus size={22} strokeWidth={1.6} aria-hidden />
                    <span>{t('mission.add')}</span>
                  </button>
                )}
              </article>
            )
          const lane = cometChannel(bot.id)
          const frame = frames[lane]
          const busy = isRunning(bot.id)
          return (
            <article className={`mission-tile${busy ? ' working' : ''}`} key={bot.id} data-testid={`mission-tile-${index}`}>
              <header className="mission-tile-head">
                <span className="mission-number">{String(index + 1).padStart(2, '0')}</span>
                <span className="mission-name" title={bot.name}>
                  {bot.name}
                </span>
                <span className="mission-status">
                  <i />
                  {t(busy ? 'mission.working' : 'mission.ready')}
                </span>
                <button className="mission-enter" aria-label={t('mission.open', { name: bot.name })} onClick={() => open(bot.id)}>
                  {t('mission.enter')}
                  <ArrowUpRight size={14} aria-hidden />
                </button>
              </header>
              <div className="mission-tile-body">
                <button className="mission-preview" aria-label={t('mission.open', { name: bot.name })} onClick={() => open(bot.id)}>
                  {frame?.data ? (
                    <img src={`data:image/jpeg;base64,${frame.data}`} alt={frame.url ?? bot.name} />
                  ) : (
                    <div className="mission-text">
                      <Monitor size={26} strokeWidth={1.4} />
                      <p>{frame?.url || t('mission.chat')}</p>
                    </div>
                  )}
                </button>
                <MiniChat botId={bot.id} />
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
