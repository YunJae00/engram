import type { BotDto } from '../../../shared/types.js'
import { useApp } from '../state.js'
import { BotAvatar } from './BotAvatar.js'

export function BotTitlePill({ bot, open, onToggle }: { bot: BotDto; open: boolean; onToggle: () => void }) {
  const { theme } = useApp()
  return <button type="button" className="bots-title-pill" data-testid="bots-title-pill" aria-expanded={open} aria-controls="bot-info-pane" onClick={onToggle}><BotAvatar id={bot.id} override={bot.avatar} primary={bot.primary === true} size={20} state="idle" theme={theme} /><span className="bots-title-pill-name">{bot.name}</span></button>
}
