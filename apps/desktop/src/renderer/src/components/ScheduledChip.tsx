import { Clock, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BotTaskDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { scheduleLabel } from '../lib/schedule.js'
import { useThreadT } from '../lib/useThreadT.js'

// What this conversation was asked to do later, as one quiet chip by the box:
// how many, and, opened, each request with when it runs and a way to cancel.
export function ScheduledChip({ botId }: { botId: string }) {
  const [kept, setKept] = useState<BotTaskDto[]>([])
  const [open, setOpen] = useState(false)
  const t = useThreadT(botId)
  useEffect(() => {
    let live = true
    const load = () => void api.botsList().then((bots) => {
      if (live) setKept((bots.find((bot) => bot.id === botId)?.tasks ?? []).filter((task) => task.schedule && !task.routineId))
    }).catch(() => undefined)
    load()
    const off = api.onEvent((event) => { if (event.type === 'bots:changed') load() })
    return () => { live = false; off() }
  }, [botId])
  if (!kept.length) return null
  return (
    <div className="scheduled-chip" data-testid="scheduled-chip">
      <button className="scheduled-chip-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Clock size={12} aria-hidden /> {t('card.keptCount', { count: kept.length })}
      </button>
      {open && (
        <ul className="scheduled-chip-list">
          {kept.map((task) => (
            <li key={task.id}>
              <span className="scheduled-chip-when">{task.schedule ? scheduleLabel(task.schedule, t) : ''}</span>
              <span className="scheduled-chip-what">{task.goal}</span>
              <button className="scheduled-chip-cancel" aria-label={t('card.cancelKept')} title={t('card.cancelKept')} onClick={() => void api.botTaskRemove(botId, task.id)}>
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
