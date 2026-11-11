import { memo, useMemo, useSyncExternalStore } from 'react'
import { BellOff } from 'lucide-react'
import type { BotDto } from '../../../shared/types.js'
import type { CometActivity } from '../lib/cometActivity.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { isSaidLine, workLabel } from '../lib/pendingStatus.js'
import { avatarState, BotAvatar, useAvatarTheme } from './BotAvatar.js'
import { CometActivityIndicator, cometActivityLabel } from './CometActivityIndicator.js'
import { SiteIcon } from './SiteIcon.js'
import { sidebarPreview } from '../lib/sidebarPreview.js'
import { markUnread, rowStatus } from '../lib/botRowStatus.js'
import { t, uiLocale } from '../i18n.js'
import { displayTaskAnswer, threadLang } from '../lib/threadLang.js'

export const SidebarConversation = memo(function SidebarConversation({ bot, state, active }: { bot: BotDto; state: CometActivity; active: boolean }) {
  const theme = useAvatarTheme()
  const thread = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(bot.id))
  const preview = useMemo(() => {
    if (state === 'waiting') return t('sidebar.waiting')
    if (thread.busy) {
      if (thread.messages.at(-1)?.text) return t('sidebar.writing')
      const step = thread.workLines.at(-1)
      return step ? sidebarPreview(isSaidLine(step) ? step.slice(6) : workLabel(step, threadLang(thread.messages))) : t('sidebar.thinking')
    }
    let last: { role: string; text: string } | undefined = bot.lastMessage
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const message = thread.messages[i]!
      if (message.error) return message.errorKind === 'outage' ? t('sidebar.noAnswer', { provider: message.provider || t('sidebar.theAi') }) : t('sidebar.couldNotFinish')
      if (message.text.trim()) { last = message; break }
    }
    if (bot.label) return bot.label
    if (!last) return sidebarPreview(bot.purpose) || t('sidebar.startConversation')
    const text = sidebarPreview(displayTaskAnswer(last.text, threadLang(thread.messages)))
    return last.role === 'user' ? t('sidebar.youSaid', { text }) : text
  }, [thread, state, bot.label, bot.lastMessage, bot.purpose])
  const date = new Date(bot.lastMessage?.at ?? bot.createdAt)
  const valid = Number.isFinite(date.getTime())
  const unread = markUnread(bot.id, bot.lastMessage, active)
  const status = rowStatus(state, unread)
  return <>
    <span className="sidebar-conversation-avatar"><BotAvatar id={bot.id} override={bot.avatar} primary={bot.primary === true} size={36} state={avatarState(state)} theme={theme} /><CometActivityIndicator state={state} /></span>
    <span className="sidebar-conversation-content" title={valid ? date.toLocaleString(uiLocale()) : undefined}>
      <span className="sidebar-conversation-top"><span className="sidebar-conversation-name" data-unread={unread || undefined}>{bot.name}</span>{bot.notify === 'off' && <BellOff className="sidebar-bell-off" size={12} role="img" aria-label={`${t('botInfo.notify')}: ${t('botInfo.notifyOff')}`} />}</span>
      <span className="sidebar-conversation-preview" data-active={state !== 'ready'}>{bot.webSites?.[0] && <SiteIcon origin={bot.webSites[0].origin} />}<span>{preview}</span></span>
    </span>
    {status && <span className="sidebar-status-dot" data-status={status} role="img" aria-label={status === 'unread' ? t('sidebar.unread') : cometActivityLabel(status === 'working' ? 'running' : state)} />}
  </>
})
