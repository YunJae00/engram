import { useRef } from 'react'
import type { BotDto } from '../../../shared/types.js'
import { BotAvatar, useAvatarTheme } from './BotAvatar.js'
import { botExamples } from '../lib/botExamples.js'
import { t } from '../i18n.js'

// An empty thread greets with the bot and three first questions; a tap sends one like a typed message.
export function BotEmpty({ bot, onPick }: { bot: BotDto; onPick: (text: string) => boolean }) {
  // One example per empty thread; a tap that could not send stays retryable.
  const used = useRef(false)
  const pick = (text: string) => {
    if (!used.current && onPick(text)) used.current = true
  }
  return <div className="bot-empty" data-testid="bot-empty">
    <BotAvatar id={bot.id} override={bot.avatar} primary={bot.primary === true} size={64} state="idle" theme={useAvatarTheme()} />
    <h2 className="bot-empty-name">{bot.name}</h2>
    {bot.label && <p className="bot-empty-label">{bot.label}</p>}
    <div className="bot-empty-chips">
      {botExamples(bot.templateId).map((key) => <button key={key} type="button" className="reply-chip" data-testid="bot-empty-chip" onMouseDown={(event) => event.preventDefault()} onClick={() => pick(t(key))}>{t(key)}</button>)}
    </div>
  </div>
}
