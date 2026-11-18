import type { BotDto } from '../../../shared/types.js'
import { BotAvatar, useAvatarTheme } from './BotAvatar.js'

export function BotEmpty({ bot }: { bot: BotDto }) {
  return <div className="bot-empty" data-testid="bot-empty">
    <BotAvatar id={bot.id} override={bot.avatar} primary={bot.primary === true} size={64} state="idle" theme={useAvatarTheme()} />
    <h2 className="bot-empty-name">{bot.name}</h2>
    {bot.label && <p className="bot-empty-label">{bot.label}</p>}
  </div>
}
