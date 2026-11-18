import { ChevronDown, EyeOff } from 'lucide-react'
import { useLayoutEffect, useRef, useState, type KeyboardEvent as KeyEvent, type ReactNode } from 'react'
import type { SidebarChange, SidebarLayout } from '../../../shared/types.js'
import { SidebarDisclosure } from './SidebarDisclosure.js'
import { t } from '../i18n.js'

interface Item { id: string; name: string; active?: boolean; recency?: number; content: ReactNode; below?: ReactNode }
interface Props {
  items: Item[]; layout: SidebarLayout['chat']
  onChange(change: SidebarChange['change']): Promise<void>
  onOpen(id: string): void
  onError(message: string): void
  hidden: Item[]
}

export function SidebarCollection({ items, layout, onChange, onOpen, onError, hidden }: Props) {
  const [showHidden, setShowHidden] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<string | null>(null)
  const visibleItems = () => [...root.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? []].filter(el => el.checkVisibility() && !el.closest('[aria-hidden="true"], [inert]'))
  const rove = () => {
    if (!root.current) return
    const shown = visibleItems()
    const stop = shown.find(el => el.dataset['treeItem'] === lastFocus.current) ?? shown.find(el => el.classList.contains('active')) ?? shown[0]
    for (const el of root.current.querySelectorAll<HTMLElement>('[role="treeitem"]')) el.tabIndex = el === stop ? 0 : -1
  }
  useLayoutEffect(rove)
  const fold = (id: string, collapsed: boolean) => void onChange({ action: 'fold-folder', id, collapsed }).catch(error => onError(String((error as Error).message ?? error)))
  const byId = new Map(items.map(item => [item.id, item]))
  const placed = new Set(layout.items.map(one => one.id))
  const layoutItems = [...layout.items, ...items.filter(item => !placed.has(item.id)).map(item => ({ id: item.id, folder: null }))]
  const byRecency = (list: Item[]) => [...list].sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0))
  const itemRows = (folder: string | null) => byRecency(layoutItems.filter(one => one.folder === folder).flatMap(one => { const item = byId.get(one.id); return item ? [item] : [] }))
  const rows = (list: Item[], loose = false) => <ul className="sidebar-list" role="group" data-testid={loose ? 'sidebar-chats' : undefined}>{list.map(item => <li key={item.id} role="treeitem" data-tree-item={`item:${item.id}`} aria-label={item.name} className={`sidebar-item${item.active ? ' active' : ''}`}>
    <button className={`sidebar-item-main bots-row${item.active ? ' active' : ''}`} title={item.name} data-testid={`bot-${item.id}`} tabIndex={-1} onClick={() => onOpen(item.id)}>{item.content}</button>
    {item.below}
  </li>)}</ul>
  const folders = layout.folders.map(one => <div className="sidebar-folder" key={one.id} data-testid={`sidebar-folder-${one.id}`} role="treeitem" aria-expanded={!one.collapsed} aria-label={one.name} data-tree-item={`folder:${one.id}`}>
    <div className="sidebar-item sidebar-folder-head">
      <button className="sidebar-item-main" aria-expanded={!one.collapsed} aria-controls={`folder-${one.id}`} tabIndex={-1} onClick={() => fold(one.id, !one.collapsed)}><ChevronDown size={12} className={one.collapsed ? 'folded' : ''} aria-hidden /><span>{one.name}</span><small>{itemRows(one.id).length}</small></button>
    </div>
    <SidebarDisclosure id={`folder-${one.id}`} open={!one.collapsed}>{rows(itemRows(one.id))}</SidebarDisclosure>
  </div>)
  const treeKey = (event: KeyEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement
    if (!event.currentTarget.contains(target) || event.nativeEvent.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
    const current = target.closest<HTMLElement>('[role="treeitem"]')
    const id = current?.dataset['treeItem']
    if (!current || !id) return
    const sep = id.indexOf(':'), type = sep < 0 ? id : id.slice(0, sep), key = id.slice(sep + 1)
    const shown = visibleItems(), at = shown.indexOf(current)
    const folder = type === 'folder' ? layout.folders.find(one => one.id === key) : undefined
    const group = id === 'hidden' || !!folder, expanded = current.getAttribute('aria-expanded') === 'true'
    const toggle = (open: boolean) => folder ? fold(folder.id, !open) : setShowHidden(open)
    let next: HTMLElement | undefined
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') next = shown[Math.min(shown.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)))]
    else if (event.key === 'Home' || event.key === 'End') next = event.key === 'Home' ? shown[0] : shown[shown.length - 1]
    else if (event.key === 'ArrowRight' && group) { if (!expanded) toggle(true); else next = shown.find(el => el !== current && current.contains(el)) }
    else if (event.key === 'ArrowLeft') { if (group && expanded) toggle(false); else next = current.parentElement?.closest<HTMLElement>('[role="treeitem"]') ?? undefined }
    else if (event.key === 'Enter' && target === current) { if (group) toggle(!expanded); else onOpen(key) }
    else return
    event.preventDefault()
    next?.focus()
  }
  return <div ref={root} className="sidebar-collection" data-testid="sidebar-chat-collection" onKeyDown={treeKey} onFocusCapture={event => { const id = (event.target as HTMLElement).dataset['treeItem']; if (id) { lastFocus.current = id; rove() } }}>
    {folders}{rows(itemRows(null), true)}
    {hidden.length > 0 && <div className="sidebar-hidden-group" role="treeitem" aria-expanded={showHidden} aria-label={t('sidebar.hiddenBots', { n: hidden.length })} data-tree-item="hidden">
      <div className="sidebar-item sidebar-folder-head"><button className="sidebar-item-main" aria-expanded={showHidden} tabIndex={-1} onClick={() => setShowHidden(value => !value)}><ChevronDown size={12} className={showHidden ? '' : 'folded'} aria-hidden /><EyeOff size={14} aria-hidden /><span>{t('sidebar.hiddenBots', { n: hidden.length })}</span></button></div>
      {showHidden && rows(byRecency(hidden))}
    </div>}
  </div>
}
