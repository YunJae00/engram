import { Bell, BellDot, Clock, LoaderCircle, Route, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { BotDto, NoticesDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t, uiLocale } from '../i18n.js'
import { CometFace } from './Icon.js'
import { BotAvatar, useAvatarTheme } from './BotAvatar.js'

const EMPTY: NoticesDto = { items: [], scheduled: [] }

function when(at: string): string {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  return today ? date.toLocaleTimeString(uiLocale(), { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString(uiLocale(), { month: 'short', day: 'numeric' })
}

function NoticeFace({ bot, theme }: { bot: BotDto | undefined; theme: 'light' | 'dark' }) {
  return bot ? <BotAvatar id={bot.id} override={bot.avatar} primary={bot.primary === true} size={20} state="idle" theme={theme} /> : <CometFace size={16} />
}

// What Engram brought on its own - a scheduled
// request that ran, a way of working it noticed - and what is set to run.
// Opening one opens its conversation, a new one when it has none yet.
export function NoticesBell({ disabled, onOpen }: { disabled?: boolean; onOpen(botId: string): void }) {
  const [inbox, setInbox] = useState<NoticesDto>(EMPTY)
  const [bots, setBots] = useState<BotDto[]>([])
  const [error, setError] = useState('')
  const theme = useAvatarTheme()
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    let alive = true, request = 0
    const load = () => {
      const mine = ++request
      void api.noticesList().then(next => { if (alive && mine === request) setInbox(next) }).catch(() => undefined)
      void api.botsList().then(next => { if (alive && mine === request) setBots(next) }).catch(() => undefined)
    }
    load()
    const off = api.onEvent(event => { if (event.type === 'notices:changed' || event.type === 'bots:changed') load() })
    return () => { alive = false; off() }
  }, [])
  const unread = inbox.items.filter(item => !item.read && !item.running).length
  const open = async (itemId: string) => {
    setError('')
    try { const botId = await api.noticesOpen(itemId); panel.current?.hidePopover(); onOpen(botId) }
    catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause)) }
  }
  const label = unread ? t('sidebar.notificationsNew', { n: unread }) : t('sidebar.notifications')
  return <>
    <button className={`sidebar-icon-button sidebar-notices${unread ? ' unread' : ''}`} data-testid="notices-bell" aria-label={label} title={label} disabled={disabled} {...{ popovertarget: id }}
      onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); if (panel.current) Object.assign(panel.current.style, { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 328))}px`, top: 'auto', bottom: `${window.innerHeight - rect.top + 6}px` }) }}>
      {unread ? <BellDot size={17} strokeWidth={1.8} aria-hidden /> : <Bell size={17} strokeWidth={1.8} aria-hidden />}
    </button>
    <div id={id} ref={panel} {...{ popover: 'auto' }} className="notices-panel" data-testid="notices-panel" aria-label={t('sidebar.notifications')}>
      <header><strong>{t('sidebar.notifications')}</strong>{inbox.items.some(item => item.read) && <button className="notices-clear" data-testid="notices-clear" onClick={() => void api.noticesClear().then(setInbox).catch(() => setError(t('sidebar.clearFailed')))}>{t('sidebar.clearRead')}</button>}</header>
      {inbox.items.length === 0 && <p className="notices-empty">{t('sidebar.noticesEmpty')}</p>}
      <ul className="notices-items">
        {inbox.items.map(item => <li key={item.id}>
          <button className={`notices-item${item.read ? '' : ' unread'}`} data-testid="notices-item" onClick={() => void open(item.id)}>
            <span className="notices-item-icon" aria-hidden>{item.running ? <LoaderCircle size={15} className="computer-spinner" /> : item.kind === 'habit' ? <Route size={15} /> : <NoticeFace bot={bots.find(bot => bot.id === item.botId)} theme={theme} />}</span>
            <span className="notices-item-text"><strong>{item.title}</strong><small>{item.running ? t('sidebar.noticeRunning') : item.text}</small></span>
            <time dateTime={item.at}>{when(item.at)}</time>
          </button>
        </li>)}
      </ul>
      {inbox.scheduled.length > 0 && <section className="notices-scheduled" aria-label={t('sidebar.scheduled')}>
        <h3>{t('sidebar.scheduled')}</h3>
        <ul>{inbox.scheduled.map(task => <li key={task.id} data-testid="notices-scheduled">
          <Clock size={13} aria-hidden /><span className="notices-scheduled-when">{task.when}</span><span className="notices-scheduled-what" title={task.goal}>{task.goal}</span>
          <button aria-label={t('sidebar.stopTask', { name: task.name })} title={t('sidebar.stop')} onClick={() => void api.noticesUnschedule(task.id).then(setInbox).catch(() => setError(t('sidebar.stopFailed')))}><X size={13} aria-hidden /></button>
        </li>)}</ul>
      </section>}
      {error && <p className="notices-error" role="alert">{error}</p>}
    </div>
  </>
}
