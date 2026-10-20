import { Bell, BellDot, Clock, LoaderCircle, Route, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import type { NoticesDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { CometFace } from './Icon.js'

const EMPTY: NoticesDto = { items: [], scheduled: [] }

function when(at: string): string {
  const date = new Date(at)
  const today = new Date().toDateString() === date.toDateString()
  return today ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// The bell by the search box: what Engram brought on its own - a scheduled
// request that ran, a way of working it noticed - and what is set to run.
// Opening one opens its conversation, a new one when it has none yet.
export function NoticesBell({ disabled, onOpen }: { disabled?: boolean; onOpen(botId: string): void }) {
  const [inbox, setInbox] = useState<NoticesDto>(EMPTY)
  const [error, setError] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()
  useEffect(() => {
    let alive = true
    const load = () => void api.noticesList().then(next => { if (alive) setInbox(next) }).catch(() => undefined)
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
  const label = unread ? `Notifications, ${unread} new` : 'Notifications'
  return <>
    <button className={`sidebar-icon-button sidebar-notices${unread ? ' unread' : ''}`} data-testid="notices-bell" aria-label={label} title={label} disabled={disabled} {...{ popovertarget: id }}
      onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); if (panel.current) Object.assign(panel.current.style, { left: `${Math.max(8, rect.right - 320)}px`, top: `${rect.bottom + 6}px` }) }}>
      {unread ? <BellDot size={17} strokeWidth={1.8} aria-hidden /> : <Bell size={17} strokeWidth={1.8} aria-hidden />}
    </button>
    <div id={id} ref={panel} {...{ popover: 'auto' }} className="notices-panel" data-testid="notices-panel" aria-label="Notifications">
      <header><strong>Notifications</strong>{inbox.items.some(item => item.read) && <button className="notices-clear" data-testid="notices-clear" onClick={() => void api.noticesClear().then(setInbox).catch(() => setError('Could not clear notifications. Try again.'))}>Clear read</button>}</header>
      {inbox.items.length === 0 && <p className="notices-empty">Nothing new. Scheduled results and ways of working Engram notices show up here.</p>}
      <ul className="notices-items">
        {inbox.items.map(item => <li key={item.id}>
          <button className={`notices-item${item.read ? '' : ' unread'}`} data-testid="notices-item" onClick={() => void open(item.id)}>
            <span className="notices-item-icon" aria-hidden>{item.running ? <LoaderCircle size={15} className="computer-spinner" /> : item.kind === 'habit' ? <Route size={15} /> : <CometFace size={16} />}</span>
            <span className="notices-item-text"><strong>{item.title}</strong><small>{item.running ? 'Running…' : item.text}</small></span>
            <time dateTime={item.at}>{when(item.at)}</time>
          </button>
        </li>)}
      </ul>
      {inbox.scheduled.length > 0 && <section className="notices-scheduled" aria-label="Scheduled">
        <h3>Scheduled</h3>
        <ul>{inbox.scheduled.map(task => <li key={task.id} data-testid="notices-scheduled">
          <Clock size={13} aria-hidden /><span className="notices-scheduled-when">{task.when}</span><span className="notices-scheduled-what" title={task.goal}>{task.goal}</span>
          <button aria-label={`Stop “${task.name}”`} title="Stop" onClick={() => void api.noticesUnschedule(task.id).then(setInbox).catch(() => setError('Could not stop it. Try again.'))}><X size={13} aria-hidden /></button>
        </li>)}</ul>
      </section>}
      {error && <p className="notices-error" role="alert">{error}</p>}
    </div>
  </>
}
