import { useEffect, useState, useSyncExternalStore } from 'react'
import type { BotDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { useApp } from '../state.js'
import { BotAvatar } from './BotAvatar.js'

export function CometTitle({ ready }: { ready: boolean }) {
  const selectedId = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.getSnapshot().selectedId)
  const [bots, setBots] = useState<BotDto[]>([])
  useEffect(() => {
    if (!ready) return
    let alive = true
    let revision = 0
    const refresh = () => {
      const request = ++revision
      void api.botsList().then((next) => {
        if (alive && request === revision) setBots(next)
      }).catch(() => undefined)
    }
    refresh()
    const unsubscribe = api.onEvent((event) => { if (event.type === 'bots:changed') refresh() })
    return () => { alive = false; unsubscribe() }
  }, [ready])
  const selected = bots.find((bot) => bot.id === selectedId)
  return <span className="conversation-title"><span className="bots-head-name" title={selected ? [selected.name, selected.purpose].filter(Boolean).join(' — ') : undefined}>{selected?.name ?? t('topbar.tabBots')}</span></span>
}

export function BotTitlePill({ bot, open, onToggle }: { bot: BotDto; open: boolean; onToggle: () => void }) {
  const { theme } = useApp()
  return <button type="button" className="bots-title-pill" data-testid="bots-title-pill" aria-expanded={open} aria-controls="bot-info-pane" onClick={onToggle}><BotAvatar id={bot.id} override={bot.avatar} primary={bot.primary === true} size={20} state="idle" theme={theme} /><span className="bots-title-pill-name">{bot.name}</span></button>
}
