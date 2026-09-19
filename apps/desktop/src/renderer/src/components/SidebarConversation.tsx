import { memo, useMemo, useSyncExternalStore } from 'react'
import type { BotDto } from '../../../shared/types.js'
import type { CometActivity } from '../lib/cometActivity.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { isSaidLine, workLabel } from '../lib/pendingStatus.js'
import { CometAvatar } from './CometAvatar.js'
import { CometActivityIndicator } from './CometActivityIndicator.js'
import { SiteIcon } from './SiteIcon.js'
import { sidebarPreview } from '../lib/sidebarPreview.js'

const clock = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const calendar = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

export const SidebarConversation = memo(function SidebarConversation({ bot, state }: { bot: BotDto; state: CometActivity }) {
  const thread = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.thread(bot.id))
  const preview = useMemo(() => {
    if (state === 'waiting') return 'Waiting for you'
    if (thread.busy) {
      if (thread.messages.at(-1)?.text) return 'Writing a reply…'
      const step = thread.workLines.at(-1)
      return step ? sidebarPreview(isSaidLine(step) ? step.slice(6) : workLabel(step)) : 'Thinking…'
    }
    let last: { role: string; text: string } | undefined = bot.lastMessage
    for (let i = thread.messages.length - 1; i >= 0; i--) {
      const message = thread.messages[i]!
      if (message.text.trim()) { last = message; break }
    }
    return last ? `${last.role === 'user' ? 'You: ' : ''}${sidebarPreview(last.text)}` : sidebarPreview(bot.purpose) || 'Start a conversation'
  }, [thread, state, bot.lastMessage, bot.purpose])
  const date = new Date(bot.lastMessage?.at ?? bot.createdAt)
  const valid = Number.isFinite(date.getTime())
  const time = valid ? (date.toDateString() === new Date().toDateString() ? clock : calendar).format(date) : ''
  return <>
    <span className="sidebar-conversation-avatar"><CometAvatar id={bot.id} /><CometActivityIndicator state={state} /></span>
    <span className="sidebar-conversation-content">
      <span className="sidebar-conversation-top"><span className="sidebar-conversation-name">{bot.name}</span>{time && <time dateTime={date.toISOString()} title={date.toLocaleString('en-US')}>{time}</time>}</span>
      <span className="sidebar-conversation-preview" data-active={state !== 'ready'}>{bot.webSites?.[0] && <SiteIcon origin={bot.webSites[0].origin} />}<span>{preview}</span></span>
    </span>
  </>
})
