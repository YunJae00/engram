import type { BotDto } from '../../../shared/types.js'
import type { CometActivity } from '../lib/cometActivity.js'
import { avatarState, BotAvatar, useAvatarTheme } from './BotAvatar.js'
import { CometActivityIndicator } from './CometActivityIndicator.js'

export function SidebarPrimary({ bot, activity, active, onOpen }: { bot: BotDto; activity: CometActivity; active: boolean; onOpen(id: string): void }) {
  const theme = useAvatarTheme()
  return <div className="sidebar-primary">
    <button className={`sidebar-primary-button${active ? ' active' : ''}`} data-testid={`bot-${bot.id}`} aria-current={active || undefined} title={bot.name} onClick={() => onOpen(bot.id)}>
      <span className="sidebar-conversation-avatar"><BotAvatar id={bot.id} override={bot.avatar} primary size={64} state={avatarState(activity)} theme={theme} /><CometActivityIndicator state={activity} /></span>
      <span className="sidebar-primary-name">{bot.name}</span>
    </button>
  </div>
}
