import { useSyncExternalStore } from 'react'
import type { BotDto } from '../../../shared/types.js'
import type { CometActivity } from '../lib/cometActivity.js'
import { avatarState, BotAvatar, useAvatarTheme } from './BotAvatar.js'
import { CometActivityIndicator } from './CometActivityIndicator.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { useTeam } from '../lib/teamLive.js'
import { lineLang } from '../lib/teamView.js'
import { SidebarTeam } from './TeamSummary.js'
import { FoundText } from './FoundText.js'
import { sidebarPreview } from '../lib/sidebarPreview.js'

export function SidebarPrimary({ bot, activity, active, onOpen, found, search }: { bot: BotDto; activity: CometActivity; active: boolean; onOpen(id: string): void; found?: string | undefined; search?: string | undefined }) {
  const theme = useAvatarTheme()
  const messages = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(bot.id).messages)
  const team = useTeam(bot.id)
  return <div className="sidebar-primary">
    <button className={`sidebar-primary-button${active ? ' active' : ''}`} data-testid={`bot-${bot.id}`} aria-current={active || undefined} title={bot.name} onClick={() => onOpen(bot.id)}>
      <span className="sidebar-conversation-avatar"><BotAvatar id={bot.id} override={bot.avatar} primary size={64} state={avatarState(activity)} theme={theme} /><CometActivityIndicator state={activity} /></span>
      <span className="sidebar-primary-name">{bot.name}</span>
      {found && search && <span className="sidebar-primary-found" data-testid="sidebar-primary-found"><FoundText text={sidebarPreview(found)} search={search} /></span>}
    </button>
    <SidebarTeam team={team} lang={lineLang(messages, bot.lastMessage)} />
  </div>
}
