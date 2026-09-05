import { ArrowUpRight, Columns2, Grid2X2, Monitor, Pause, Play } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BotDto, MissionFrameDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads, selectComet } from '../lib/cometThreadsLive.js'
import { useShellState } from '../state-slices.js'

type Layout = 1 | 2 | 4

function savedSlots(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem('engram.mission.slots') ?? '[]')
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string').slice(0, 4) : []
  } catch { return [] }
}

export function MissionControl() {
  const { setActivity } = useShellState()
  const { threads } = useSyncExternalStore(cometThreads.subscribe, cometThreads.getSnapshot)
  const [bots, setBots] = useState<BotDto[]>([])
  const [active, setActive] = useState<string[]>([])
  const [slots, setSlots] = useState(savedSlots)
  const [layout, setLayout] = useState<Layout>(() => {
    const saved = Number(localStorage.getItem('engram.mission.layout'))
    return saved === 1 || saved === 2 ? saved : 4
  })
  const [frames, setFrames] = useState<Record<string, MissionFrameDto>>({})
  const [paused, setPaused] = useState(false)
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
        setSlots((previous) => {
          const valid = previous.filter((id) => nextBots.some((bot) => bot.id === id))
          const ordered = [...nextBots].sort((a, b) => Number(nextActive.includes(cometChannel(b.id))) - Number(nextActive.includes(cometChannel(a.id))))
          const filled = [...valid, ...ordered.map((bot) => bot.id).filter((id) => !valid.includes(id))].slice(0, 4)
          return filled.join() === previous.join() ? previous : filled
        })
      } catch { if (alive) setError(true) }
      if (alive) timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [])

  useEffect(() => localStorage.setItem('engram.mission.slots', JSON.stringify(slots)), [slots])
  useEffect(() => localStorage.setItem('engram.mission.layout', String(layout)), [layout])
  const watched = slots.slice(0, layout).map(cometChannel).join('|')
  useEffect(() => {
    if (!watched || paused) return
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
            return merged
          })
        } catch { if (alive) setError(true) }
      }
      if (alive) timer = setTimeout(() => void refresh(), 1000)
    }
    void refresh()
    return () => { alive = false; clearTimeout(timer) }
  }, [watched, paused])

  const running = bots.filter((bot) => threads[bot.id]?.busy || active.includes(cometChannel(bot.id)))
  const choose = (index: number, id: string) => setSlots((previous) => {
    const next = [...previous]
    const other = next.indexOf(id)
    if (other >= 0) next[other] = next[index] ?? ''
    next[index] = id
    return next
  })
  const open = (id: string) => { selectComet(id); setActivity('bots') }

  return (
    <section className="mission-control" data-testid="mission-control">
      <header className="mission-head">
        <div><h1>{t('mission.title')}</h1><p>{t('mission.summary', { count: running.length })}</p></div>
        <div className="mission-actions">
          <button className="mission-follow" onClick={() => setSlots([...running, ...bots.filter((bot) => !running.includes(bot))].slice(0, 4).map((bot) => bot.id))}>{t('mission.running')}</button>
          <div className="mission-layout" aria-label={t('mission.layout')}>
            {([1, 2, 4] as const).map((count) => {
              const Icon = count === 1 ? Monitor : count === 2 ? Columns2 : Grid2X2
              return <button key={count} aria-pressed={layout === count} aria-label={t('mission.panels', { count })} data-testid={`mission-layout-${count}`} onClick={() => setLayout(count)}><Icon size={16} /><span>{count}</span></button>
            })}
          </div>
          <button className="mission-pause" aria-pressed={paused} title={t(paused ? 'mission.resume' : 'mission.pause')} aria-label={t(paused ? 'mission.resume' : 'mission.pause')} onClick={() => setPaused(!paused)}>{paused ? <Play size={15} /> : <Pause size={15} />}</button>
        </div>
      </header>
      {error && <p className="mission-error" role="status">{t('mission.error')}</p>}
      <div className={`mission-grid mission-grid-${layout}`}>
        {Array.from({ length: layout }, (_, index) => {
          const bot = bots.find((item) => item.id === slots[index])
          const thread = bot ? threads[bot.id] : undefined
          const lane = bot ? cometChannel(bot.id) : ''
          const frame = frames[lane]
          const busy = Boolean(bot && (thread?.busy || active.includes(lane)))
          const detail = thread?.workLines.at(-1) || thread?.messages.at(-1)?.text || bot?.purpose || t('mission.waiting')
          return (
            <article className={`mission-tile${busy ? ' working' : ''}`} key={index} data-testid={`mission-tile-${index}`}>
              <header className="mission-tile-head">
                <span className="mission-number">{String(index + 1).padStart(2, '0')}</span>
                <select aria-label={t('mission.choose', { count: index + 1 })} value={bot?.id ?? ''} onChange={(event) => choose(index, event.target.value)}>
                  <option value="" disabled>{t('mission.select')}</option>
                  {bots.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}
                </select>
                <span className="mission-status"><i />{t(busy ? 'mission.working' : 'mission.ready')}</span>
              </header>
              <button className="mission-preview" disabled={!bot} aria-label={bot ? t('mission.open', { name: bot.name }) : t('mission.select')} onClick={() => bot && open(bot.id)}>
                {frame?.data ? <img src={`data:image/jpeg;base64,${frame.data}`} alt={frame.url ?? bot?.name} /> : <div className="mission-text"><Monitor size={26} strokeWidth={1.4} /><strong>{bot?.name ?? t('mission.empty')}</strong><p>{bot ? detail : t('mission.emptyHint')}</p></div>}
                {bot && <span className="mission-enter">{t('mission.enter')}<ArrowUpRight size={15} /></span>}
              </button>
              <footer className="mission-tile-foot"><span title={frame?.url || detail}>{frame?.url || detail}</span><small>{t(paused ? 'mission.paused' : frame?.on ? 'mission.live' : 'mission.chat')}</small></footer>
            </article>
          )
        })}
      </div>
    </section>
  )
}
