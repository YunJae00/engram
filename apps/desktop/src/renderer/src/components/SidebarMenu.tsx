import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, List, MessageSquare, Orbit } from 'lucide-react'
import { t } from '../i18n.js'

// The sidebar's title and the three places it leads to. There is one Engram:
// nothing here creates, switches or deletes a workspace.
export function SidebarMenu({ activity, onNavigate }: {
  activity: string
  onNavigate(activity: 'bots' | 'sky' | 'list'): void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect(), menu = menuRef.current
      if (!anchor || !menu) return
      menu.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - menu.offsetWidth - 8))}px`
      menu.style.top = `${Math.min(anchor.bottom + 6, innerHeight - 80)}px`
      menu.style.maxHeight = `${Math.max(64, innerHeight - anchor.bottom - 14)}px`
    }
    place()
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // Close on an outside mousedown or Escape (window-level so clicks anywhere on the canvas dismiss it).
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      rootRef.current?.querySelector('button')?.focus()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        className="workspace-trigger"
        data-testid="engram-menu-button"
        onClick={() => setOpen((v) => !v)}
        title={t('sidebar.engramMenu')}
        aria-label={t('sidebar.engramMenu')}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="workspace-name">Engram</span>
        <ChevronDown className="workspace-chevron" size={13} strokeWidth={1.8} aria-hidden />
      </button>

      {open && createPortal(
        <div className="workspace-menu" ref={menuRef} role="dialog" aria-label={t('sidebar.engramMenu')} data-testid="engram-menu" onKeyDown={event => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
          const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('button')].filter(row => row.getClientRects().length > 0 && !row.hasAttribute('disabled'))
          if (!rows.length) return
          event.preventDefault()
          const at = rows.indexOf(document.activeElement as HTMLElement)
          const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : (at + (event.key === 'ArrowUp' ? -1 : 1) + rows.length) % rows.length
          rows[next]?.focus()
        }}>
          <nav className="sidebar-nav" aria-label={t('sidebar.explore')}>
            {([
              ['bots', t('topbar.tabBots'), <MessageSquare key="bots" size={17} aria-hidden />],
              ['sky', t('topbar.tabSky'), <Orbit key="sky" size={17} aria-hidden />],
              ['list', t('activity.list'), <List key="list" size={17} aria-hidden />],
            ] as const).map(([key, label, icon]) => <button key={key} className={`sidebar-nav-row${activity === key ? ' active' : ''}`} aria-current={activity === key ? 'page' : undefined} data-testid={`activity-${key}`} onClick={() => { setOpen(false); onNavigate(key) }}>{icon}<span>{label}</span></button>)}
          </nav>
        </div>, document.body
      )}
    </div>
  )
}
