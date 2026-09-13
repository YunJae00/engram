import { memo, useSyncExternalStore } from 'react'
import type { BotDto } from '../../../shared/types.js'
import type { CometActivity } from '../lib/cometActivity.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { isSaidLine, workLabel } from '../lib/pendingStatus.js'
import { CometAvatar } from './CometAvatar.js'
import { CometActivityIndicator } from './CometActivityIndicator.js'
import { SiteIcon } from './SiteIcon.js'

const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })
const calendar = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const plain = (text: string) => text.replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`#*_>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160)

export const SidebarConversation = memo(function SidebarConversation({ bot, state }: { bot: BotDto; state: CometActivity }) {
  const preview = useSyncExternalStore(cometThreads.subscribe, () => {
    const thread = cometThreads.thread(bot.id)
    if (state === 'waiting') return 'Waiting for you'
    if (thread.busy) {
      if (thread.messages.at(-1)?.text) return 'Writing a reply…'
      const step = thread.workLines.at(-1)
      return step ? plain(isSaidLine(step) ? step.slice(6) : workLabel(step)) : 'Thinking…'
    }
    const last = [...thread.messages].reverse().find(message => message.text.trim()) ?? bot.lastMessage
    return last ? `${last.role === 'user' ? 'You: ' : ''}${plain(last.text)}` : plain(bot.purpose) || 'Start a conversation'
  })
  const date = new Date(bot.lastMessage?.at ?? bot.createdAt)
  const valid = Number.isFinite(date.getTime())
  const time = valid ? (date.toDateString() === new Date().toDateString() ? clock : calendar).format(date) : ''
  return <>
    <span className="sidebar-conversation-avatar"><CometAvatar id={bot.id} /><CometActivityIndicator state={state} /></span>
    <span className="sidebar-conversation-content">
      <span className="sidebar-conversation-top"><span className="sidebar-conversation-name">{bot.name}</span>{time && <time dateTime={date.toISOString()} title={date.toLocaleString()}>{time}</time>}</span>
      <span className="sidebar-conversation-preview" data-active={state !== 'ready'}>{bot.webSites?.[0] && <SiteIcon origin={bot.webSites[0].origin} />}<span>{preview}</span></span>
    </span>
  </>
})
