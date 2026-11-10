import { ChevronDown, Eye, EyeOff, Folder, FolderInput, FolderPlus, MoreHorizontal, Pencil, Pin, PinOff, Star, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { BotDto, SidebarChange, SidebarKind, SidebarLayout } from '../../../shared/types.js'
import { botMenuItems, type BotMenuRun } from '../lib/sidebarBots.js'
import { SidebarDisclosure } from './SidebarDisclosure.js'
import { DeleteConversationDialog } from './DeleteConversationDialog.js'

interface Item { id: string; name: string; active?: boolean; recency?: number; leading?: ReactNode; content?: ReactNode; bot?: BotDto }
interface Props {
  kind: SidebarKind; items: Item[]; layout: SidebarLayout[SidebarKind]; newFolder: number
  onChange(change: SidebarChange['change']): Promise<void>
  onOpen(id: string): void; onRename(id: string, name: string): Promise<void>; onRemove(id: string): Promise<void>
  onError(message: string): void
  /** Bot-list mode: a tree with loose pinned rows first and these hidden rows in a closed group last. */
  hidden?: Item[]; search?: boolean
  /** Bot rows: every section (unfiltered by search) and the bot writes their menu dispatches. */
  sections?: readonly { id: string; name: string }[]
  onBotUpdate?(id: string, patch: { hidden?: true; primary?: true }): Promise<void>
  onNewSection?(id: string, name: string): Promise<void>
}
const MIME = 'application/x-engram-sidebar'
type Entry = { type: 'folder' | 'item'; id: string }
const BOT_ICONS: Record<string, typeof Pin> = { Rename: Pencil, Pin, Unpin: PinOff, 'Move to new section': FolderPlus, 'Hide from sidebar': EyeOff, Show: Eye, 'Make primary': Star, Delete: Trash2 }

export function SidebarCollection({ kind, items, layout, newFolder, onChange, onOpen, onRename, onRemove, onError, hidden, search = false, sections = [], onBotUpdate, onNewSection }: Props) {
  const tree = hidden !== undefined
  const [showHidden, setShowHidden] = useState(false)
  const [editing, setEditing] = useState<{ type: 'folder' | 'item' | 'new'; id: string; name: string; target?: string } | null>(null)
  const [menu, setMenu] = useState<Entry | null>(null)
  const [deleting, setDeleting] = useState<{ entry: Entry; name: string; ids: string[] } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [insertion, setInsertion] = useState<{ folder: string | null; before?: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const drag = useRef<Entry | null>(null)
  const [dragging, setDragging] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const menuAnchor = useRef<HTMLButtonElement | null>(null)
  const lastNewFolder = useRef(newFolder)
  const renaming = useRef(false)
  useLayoutEffect(() => {
    if (!menu) return
    const place = () => {
      if (!menuRef.current || !menuAnchor.current) { setMenu(null); return }
      const button = menuAnchor.current, anchor = button.getBoundingClientRect(), box = menuRef.current
      const clip = button.closest('.sidebar-scroll')?.getBoundingClientRect()
      if (!button.isConnected || button.closest('[aria-hidden="true"]') || !anchor.width || anchor.bottom <= Math.max(0, clip?.top ?? 0) || anchor.top >= Math.min(innerHeight, clip?.bottom ?? innerHeight) || anchor.right <= 0 || anchor.left >= innerWidth) {
        setMenu(null); return
      }
      Object.assign(box.style, { left: `${Math.max(8, anchor.right - box.offsetWidth)}px`, top: `${Math.max(8, Math.min(anchor.bottom + 4, innerHeight - box.offsetHeight - 8))}px` })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [menu, layout])
  useEffect(() => {
    if (newFolder === lastNewFolder.current) return
    lastNewFolder.current = newFolder
    setEditing({ type: 'new', id: '', name: '' }); setMenu(null)
  }, [newFolder])
  useEffect(() => { if (menu) menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [menu])
  const attempt = async (run: () => Promise<void>) => {
    setSaving(true)
    try { await run() } catch (error) { onError(String((error as Error).message ?? error)) }
    finally { setSaving(false) }
  }
  useEffect(() => {
    if (!menu) return
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !menuAnchor.current?.contains(event.target as Node)) { setMenu(null) } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); menuAnchor.current?.focus() } }
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) }
  }, [menu])
  const rename = async () => {
    if (!editing || renaming.current) return
    renaming.current = true
    const entry = editing; setEditing(null)
    if (entry.name.trim()) await attempt(() => entry.type === 'item' ? onRename(entry.id, entry.name.trim()) : entry.target && onNewSection ? onNewSection(entry.target, entry.name.trim()) : onChange(entry.type === 'new' ? { action: 'create-folder', name: entry.name } : { action: 'rename-folder', id: entry.id, name: entry.name }))
    renaming.current = false
  }
  const input = () => <input className="sidebar-rename" autoFocus maxLength={80} aria-label={editing?.type === 'new' ? 'Folder name' : 'Rename'} data-testid={editing?.type === 'item' ? `sidebar-${kind}-name-${editing.id}` : `sidebar-${kind}-folder-name`} value={editing?.name ?? ''}
    onChange={event => setEditing(current => current ? { ...current, name: event.target.value } : null)} onBlur={() => void rename()}
    onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { event.preventDefault(); renaming.current = true; setEditing(null); queueMicrotask(() => { renaming.current = false }) } }} />
  const start = (event: DragEvent, entry: Entry) => {
    event.stopPropagation(); drag.current = entry; setDragging(true); setMenu(null)
    event.dataTransfer.setData(MIME, JSON.stringify({ ...entry, kind })); event.dataTransfer.effectAllowed = 'move'
  }
  const accept = (event: DragEvent, key: string) => {
    if (!drag.current || !event.dataTransfer.types.includes(MIME)) return
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setOver(key); setInsertion(null)
  }
  const drop = (event: DragEvent, destination: string | null, before?: string, folderTarget?: string) => {
    event.preventDefault(); event.stopPropagation(); setOver(null); setInsertion(null); setDragging(false)
    let source: Entry & { kind: SidebarKind }
    try { source = JSON.parse(event.dataTransfer.getData(MIME)) } catch { return }
    drag.current = null
    if (source.kind !== kind || saving) return
    if (source.type === 'folder') void attempt(() => onChange({ action: 'move-folder', id: source.id, ...(folderTarget ? { before: folderTarget } : {}) }))
    else if (source.type === 'item') void attempt(() => onChange({ action: 'move-item', id: source.id, folder: destination, ...(before ? { before } : {}) }))
  }
  const byId = new Map(items.map(item => [item.id, item]))
  const placed = new Set(layout.items.map(one => one.id))
  // A bot the layout has not caught up with yet still shows as a loose row.
  const layoutItems = tree ? [...layout.items, ...items.filter(item => !placed.has(item.id)).map(item => ({ id: item.id, folder: null, pinned: false }))] : layout.items
  const itemRows = (folder: string | null) => layoutItems.filter(one => one.folder === folder)
    // Pinned rows keep their manual order; unpinned rows follow the latest activity.
    .sort((a, b) => kind === 'chat' ? Number(!!b.pinned) - Number(!!a.pinned) || (a.pinned ? 0 : (byId.get(b.id)?.recency ?? 0) - (byId.get(a.id)?.recency ?? 0)) : 0)
    .flatMap(one => { const item = byId.get(one.id); return item ? [{ ...item, pinned: kind === 'chat' && !!one.pinned }] : [] })
  const openMenu = (row: HTMLElement, entry: Entry) => {
    const more = row.closest('li')?.querySelector<HTMLButtonElement>('.sidebar-more')
    if (!more) return
    menuAnchor.current = more; setMenu(entry)
  }
  const runBot = (item: Item, run: BotMenuRun) => {
    setMenu(null)
    if (run.kind === 'rename') setEditing({ type: 'item', id: item.id, name: item.name })
    else if (run.kind === 'new-section') setEditing({ type: 'new', id: '', name: '', target: item.id })
    else if (run.kind === 'delete') setDeleting({ entry: { type: 'item', id: item.id }, name: item.name, ids: [] })
    else {
      menuAnchor.current?.focus()
      void attempt(async () => { if (run.kind === 'layout') await onChange(run.change); else await onBotUpdate?.(item.id, run.patch) })
    }
  }
  const botActions = (item: Item) => {
    const place = layout.items.find(one => one.id === item.id)
    return item.bot && botMenuItems(item.bot, { folder: place?.folder ?? null, pinned: !!place?.pinned }, sections).map(({ label, run }) => {
      const Icon = BOT_ICONS[label] ?? FolderInput
      return <button key={label} disabled={saving && run.kind !== 'rename'} data-testid={run.kind === 'rename' ? `sidebar-${kind}-rename-${item.id}` : undefined} onClick={() => runBot(item, run)}><Icon size={13} aria-hidden /><span className="sidebar-menu-label" title={label}>{label}</span></button>
    })
  }
  const controls = (entry: Entry, name: string, pinned = false, item?: Item) => <>
    <div className="sidebar-row-actions">
      <button className="sidebar-more" aria-label={`Options for ${name}`} aria-haspopup="dialog" aria-expanded={menu?.id === entry.id} data-testid={entry.type === 'item' ? `sidebar-${kind}-menu-${entry.id}` : undefined} onClick={event => { menuAnchor.current = event.currentTarget; setMenu(current => current?.id === entry.id ? null : entry) }}><MoreHorizontal size={15} aria-hidden /></button>
      {pinned && <span className="sidebar-pin" role="img" aria-label="Pinned conversation" title="Pinned conversation"><Pin size={12} aria-hidden /></span>}
    </div>
    {menu?.id === entry.id && menu.type === entry.type && createPortal(<div className="sidebar-menu sidebar-organize-menu" role="dialog" aria-label={`Options for ${name}`} ref={menuRef} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); menuAnchor.current?.focus(); return }
      if (event.key === 'Tab') { setMenu(null); menuAnchor.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }}>
      {item?.bot ? botActions(item) : <>
      <button data-testid={entry.type === 'item' ? `sidebar-${kind}-rename-${entry.id}` : undefined} onClick={() => { setEditing({ ...entry, name }); setMenu(null) }}><Pencil size={13} aria-hidden />Rename</button>
      {entry.type === 'item' && kind === 'chat' && <button disabled={saving} onClick={() => { void attempt(() => onChange({ action: 'pin-item', id: entry.id, pinned: !pinned })); setMenu(null); menuAnchor.current?.focus() }}>{pinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}{pinned ? 'Unpin' : 'Pin'}</button>}
      <button disabled={saving} onClick={() => {
        setDeleting({ entry, name, ids: layout.items.filter(item => item.folder === entry.id).map(item => item.id) }); setMenu(null)
      }}><Trash2 size={13} aria-hidden />Delete</button></>}
    </div>, document.body)}
  </>
  const rows = (folder: string | null, only?: boolean, fixed?: Item[]) => {
    const siblings = fixed ? [...fixed].sort((a, b) => (b.recency ?? 0) - (a.recency ?? 0)).map(item => ({ ...item, pinned: false })) : itemRows(folder).filter(item => only === undefined || item.pinned === only)
    const pinned = kind === 'chat' && !!layout.items.find(one => one.id === drag.current?.id)?.pinned
    const slot = insertion?.folder === folder ? insertion.before ? siblings.findIndex(item => item.id === insertion.before) : pinned ? siblings.filter(item => item.pinned).length : siblings.length : -1
    const beforeAt = (event: DragEvent, index: number) => {
      const after = event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.clientHeight / 2
      return siblings.slice(index + Number(after)).find(one => one.id !== drag.current?.id && one.pinned === pinned)?.id
    }
    return <ul className="sidebar-list" role={tree ? 'group' : undefined} data-testid={folder === null && only !== true && !fixed ? `sidebar-${kind === 'chat' ? 'chats' : 'routines'}` : undefined}>{siblings.map((item, index) => <li key={item.id} role={tree ? 'treeitem' : undefined} className={`sidebar-item${item.active ? ' active' : ''}`} data-pinned={item.pinned || undefined} data-drag-source={dragging && drag.current?.id === item.id || undefined} data-insert={slot === index ? 'before' : slot === siblings.length && index === siblings.length - 1 ? 'after' : undefined} data-shift={slot < 0 ? undefined : index < slot ? 'up' : 'down'} draggable={!fixed && !editing && !saving}
    onDragStart={event => { if (fixed) event.preventDefault(); else start(event, { type: 'item', id: item.id }) }} onDragEnd={() => { drag.current = null; setOver(null); setInsertion(null) }} onDragOver={event => {
      if (fixed || drag.current?.type !== 'item' || !event.dataTransfer.types.includes(MIME)) return
      if (drag.current.id === item.id) { setInsertion(null); return }
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setOver(null)
      const before = beforeAt(event, index)
      setInsertion(current => current?.folder === folder && current.before === before ? current : { folder, before })
    }}
    onDrop={event => {
      if (!fixed) drop(event, folder, beforeAt(event, index))
    }} onContextMenu={item.bot ? event => { event.preventDefault(); openMenu(event.currentTarget, { type: 'item', id: item.id }) } : undefined}>
    {editing?.id === item.id && editing.type === 'item' ? input() : <button className={`sidebar-item-main${kind === 'chat' ? ' bots-row' : ' sidebar-routine-row'}${item.active ? ' active' : ''}`} title={item.name} data-testid={kind === 'chat' ? `bot-${item.id}` : `sidebar-routine-run-${item.id}`} onClick={() => onOpen(item.id)} onKeyDown={item.bot ? event => { if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') { event.preventDefault(); openMenu(event.currentTarget, { type: 'item', id: item.id }) } } : undefined}>{item.content ?? <>{item.leading}<span>{item.name}</span></>}</button>}
    {controls({ type: 'item', id: item.id }, item.name, item.pinned, item)}
  </li>)}</ul>
  }
  const folders = layout.folders.map(one => <div className={`sidebar-folder${over === one.id ? ' sidebar-drop-target' : ''}`} key={one.id} data-testid={`sidebar-folder-${one.id}`}>
      <div className="sidebar-item sidebar-folder-head" draggable={!editing && !saving} onDragStart={event => start(event, { type: 'folder', id: one.id })} onDragEnd={() => { drag.current = null; setOver(null) }} onDragOver={event => accept(event, one.id)} onDrop={event => drop(event, one.id, undefined, one.id)}>
        {editing?.type === 'folder' && editing.id === one.id ? input() : <button className="sidebar-item-main" aria-expanded={!one.collapsed} aria-controls={`folder-${one.id}`} onClick={() => void attempt(() => onChange({ action: 'fold-folder', id: one.id, collapsed: !one.collapsed }))}><ChevronDown size={12} className={one.collapsed ? 'folded' : ''} aria-hidden /><Folder size={14} aria-hidden /><span>{one.name}</span><small>{itemRows(one.id).length}</small></button>}
        {controls({ type: 'folder', id: one.id }, one.name)}
      </div>
      <SidebarDisclosure id={`folder-${one.id}`} open={!one.collapsed}>{rows(one.id)}{dragging && itemRows(one.id).length === 0 && <div className="sidebar-folder-empty" onDragOver={event => accept(event, one.id)} onDrop={event => drop(event, one.id)}>Drop here</div>}</SidebarDisclosure>
    </div>)
  const hiddenOpen = search || showHidden
  return <div className={`sidebar-collection${dragging ? ' dragging' : ''}`} data-testid={`sidebar-${kind}-collection`} aria-busy={saving} onDragEnd={() => { setDragging(false); setInsertion(null) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) { setOver(null); setInsertion(null) } }}>
    {deleting && <DeleteConversationDialog kind={kind} name={deleting.name} summaryId={deleting.entry.type === 'item' && kind === 'chat' ? deleting.entry.id : undefined} count={deleting.entry.type === 'folder' ? deleting.ids.length : undefined} onClose={() => { setDeleting(null); menuAnchor.current?.focus() }} onDelete={async contents => {
      if (deleting.entry.type === 'item') await onRemove(deleting.entry.id)
      else {
        if (contents) for (const id of deleting.ids) await onRemove(id)
        await onChange({ action: 'remove-folder', id: deleting.entry.id })
      }
    }} />}
    {editing?.type === 'new' && <div className="sidebar-folder-create"><Folder size={14} aria-hidden />{input()}</div>}
    {tree ? <>{rows(null, true)}{folders}{rows(null, false)}</> : <>{folders}{rows(null)}</>}
    {tree && hidden.length > 0 && <div className="sidebar-hidden-group">
      <div className="sidebar-item sidebar-folder-head"><button className="sidebar-item-main" aria-expanded={hiddenOpen} onClick={() => setShowHidden(value => !value)}><ChevronDown size={12} className={hiddenOpen ? '' : 'folded'} aria-hidden /><EyeOff size={14} aria-hidden /><span>{`Hidden bots (${hidden.length})`}</span></button></div>
      {hiddenOpen && rows(null, undefined, hidden)}
    </div>}
    {dragging && layout.folders.length > 0 && <div className={`sidebar-unfile${over === 'root' ? ' sidebar-drop-target' : ''}`} onDragOver={event => accept(event, 'root')} onDrop={event => drop(event, null)}>Move out of folders</div>}
  </div>
}
