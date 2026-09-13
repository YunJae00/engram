import { ChevronDown, Folder, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { SidebarChange, SidebarKind, SidebarLayout } from '../../../shared/types.js'
import { SidebarDisclosure } from './SidebarDisclosure.js'

interface Item { id: string; name: string; active?: boolean; leading?: ReactNode; content?: ReactNode }
interface Props {
  kind: SidebarKind; items: Item[]; layout: SidebarLayout[SidebarKind]; newFolder: number
  onChange(change: SidebarChange['change']): Promise<void>
  onOpen(id: string): void; onRename(id: string, name: string): Promise<void>; onRemove(id: string): Promise<void>
  onError(message: string): void
}
const MIME = 'application/x-engram-sidebar'
type Entry = { type: 'folder' | 'item'; id: string }

export function SidebarCollection({ kind, items, layout, newFolder, onChange, onOpen, onRename, onRemove, onError }: Props) {
  const [editing, setEditing] = useState<{ type: 'folder' | 'item' | 'new'; id: string; name: string } | null>(null)
  const [menu, setMenu] = useState<Entry | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [over, setOver] = useState<string | null>(null)
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
      if (!menuRef.current || !menuAnchor.current) { setMenu(null); setConfirm(false); return }
      const button = menuAnchor.current, anchor = button.getBoundingClientRect(), box = menuRef.current
      const clip = button.closest('.sidebar-scroll')?.getBoundingClientRect()
      if (!button.isConnected || button.closest('[aria-hidden="true"]') || !anchor.width || anchor.bottom <= Math.max(0, clip?.top ?? 0) || anchor.top >= Math.min(innerHeight, clip?.bottom ?? innerHeight) || anchor.right <= 0 || anchor.left >= innerWidth) {
        setMenu(null); setConfirm(false); return
      }
      Object.assign(box.style, { left: `${Math.max(8, anchor.right - box.offsetWidth)}px`, top: `${Math.max(8, Math.min(anchor.bottom + 4, innerHeight - box.offsetHeight - 8))}px` })
    }
    place()
    window.addEventListener('resize', place); window.addEventListener('scroll', place, true)
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true) }
  }, [menu, confirm, layout])
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
    const close = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node) && !menuAnchor.current?.contains(event.target as Node)) { setMenu(null); setConfirm(false) } }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); setConfirm(false); menuAnchor.current?.focus() } }
    window.addEventListener('pointerdown', close); window.addEventListener('keydown', escape)
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) }
  }, [menu])
  const rename = async () => {
    if (!editing || renaming.current) return
    renaming.current = true
    const entry = editing; setEditing(null)
    if (entry.name.trim()) await attempt(() => entry.type === 'item' ? onRename(entry.id, entry.name.trim()) : onChange(entry.type === 'new' ? { action: 'create-folder', name: entry.name } : { action: 'rename-folder', id: entry.id, name: entry.name }))
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
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setOver(key)
  }
  const drop = (event: DragEvent, destination: string | null, before?: string, folderTarget?: string) => {
    event.preventDefault(); event.stopPropagation(); setOver(null); setDragging(false)
    let source: Entry & { kind: SidebarKind }
    try { source = JSON.parse(event.dataTransfer.getData(MIME)) } catch { return }
    drag.current = null
    if (source.kind !== kind || saving) return
    if (source.type === 'folder') void attempt(() => onChange({ action: 'move-folder', id: source.id, ...(folderTarget ? { before: folderTarget } : {}) }))
    else if (source.type === 'item') void attempt(() => onChange({ action: 'move-item', id: source.id, folder: destination, ...(before ? { before } : {}) }))
  }
  const byId = new Map(items.map(item => [item.id, item]))
  const itemRows = (folder: string | null) => layout.items.filter(one => one.folder === folder)
    .sort((a, b) => kind === 'chat' ? Number(!!b.pinned) - Number(!!a.pinned) : 0)
    .flatMap(one => { const item = byId.get(one.id); return item ? [{ ...item, pinned: kind === 'chat' && !!one.pinned }] : [] })
  const controls = (entry: Entry, name: string, pinned = false) => <>
    <div className="sidebar-row-actions">
      <button className="sidebar-more" aria-label={`Options for ${name}`} aria-haspopup="dialog" aria-expanded={menu?.id === entry.id} data-testid={entry.type === 'item' ? `sidebar-${kind}-menu-${entry.id}` : undefined} onClick={event => { menuAnchor.current = event.currentTarget; setConfirm(false); setMenu(current => current?.id === entry.id ? null : entry) }}><MoreHorizontal size={15} aria-hidden /></button>
      {pinned && <span className="sidebar-pin" role="img" aria-label="Pinned conversation" title="Pinned conversation"><Pin size={12} aria-hidden /></span>}
    </div>
    {menu?.id === entry.id && menu.type === entry.type && createPortal(<div className="sidebar-menu sidebar-organize-menu" role="dialog" aria-label={`Options for ${name}`} ref={menuRef} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMenu(null); setConfirm(false); menuAnchor.current?.focus(); return }
      if (event.key === 'Tab') { setMenu(null); setConfirm(false); menuAnchor.current?.focus(); return }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
      buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    }}>
      <button data-testid={entry.type === 'item' ? `sidebar-${kind}-rename-${entry.id}` : undefined} onClick={() => { setEditing({ ...entry, name }); setMenu(null) }}><Pencil size={13} aria-hidden />Rename</button>
      {entry.type === 'item' && kind === 'chat' && <button disabled={saving} onClick={() => { void attempt(() => onChange({ action: 'pin-item', id: entry.id, pinned: !pinned })); setMenu(null); menuAnchor.current?.focus() }}>{pinned ? <PinOff size={13} aria-hidden /> : <Pin size={13} aria-hidden />}{pinned ? 'Unpin' : 'Pin'}</button>}
      <button disabled={saving} className={confirm ? 'danger' : ''} title={entry.type === 'folder' ? 'Delete folder and keep its items' : undefined} onClick={() => {
        if (!confirm) { setConfirm(true); return }
        void attempt(() => entry.type === 'item' ? onRemove(entry.id) : onChange({ action: 'remove-folder', id: entry.id })); setMenu(null)
      }}><Trash2 size={13} aria-hidden />{confirm ? entry.type === 'folder' ? 'Delete folder · keep items?' : 'Delete for good?' : 'Delete'}</button>
    </div>, document.body)}
  </>
  const rows = (folder: string | null) => <ul className="sidebar-list" data-testid={folder === null ? `sidebar-${kind === 'chat' ? 'chats' : 'routines'}` : undefined}>{itemRows(folder).map((item, index, siblings) => <li key={item.id} className={`sidebar-item${item.active ? ' active' : ''}${over === item.id ? ' sidebar-drop-target' : ''}`} data-pinned={item.pinned || undefined} draggable={!editing && !saving}
    onDragStart={event => start(event, { type: 'item', id: item.id })} onDragEnd={() => { drag.current = null; setOver(null) }} onDragOver={event => accept(event, item.id)}
    onDrop={event => {
      const after = event.clientY > event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2
      const pinned = kind === 'chat' && !!layout.items.find(one => one.id === drag.current?.id)?.pinned
      drop(event, folder, siblings.slice(index + Number(after)).find(one => one.pinned === pinned)?.id)
    }}>
    {editing?.id === item.id && editing.type === 'item' ? input() : <button className={`sidebar-item-main${kind === 'chat' ? ' bots-row' : ''}${item.active ? ' active' : ''}`} title={item.name} data-testid={kind === 'chat' ? `bot-${item.id}` : `sidebar-routine-run-${item.id}`} onClick={() => onOpen(item.id)}>{item.content ?? <>{item.leading}<span>{item.name}</span></>}</button>}
    {controls({ type: 'item', id: item.id }, item.name, item.pinned)}
  </li>)}</ul>
  return <div className={`sidebar-collection${dragging ? ' dragging' : ''}`} data-testid={`sidebar-${kind}-collection`} aria-busy={saving} onDragEnd={() => setDragging(false)} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(null) }}>
    {editing?.type === 'new' && <div className="sidebar-folder-create"><Folder size={14} aria-hidden />{input()}</div>}
    {layout.folders.map(one => <div className={`sidebar-folder${over === one.id ? ' sidebar-drop-target' : ''}`} key={one.id} data-testid={`sidebar-folder-${one.id}`}>
      <div className="sidebar-item sidebar-folder-head" draggable={!editing && !saving} onDragStart={event => start(event, { type: 'folder', id: one.id })} onDragEnd={() => { drag.current = null; setOver(null) }} onDragOver={event => accept(event, one.id)} onDrop={event => drop(event, one.id, undefined, one.id)}>
        {editing?.type === 'folder' && editing.id === one.id ? input() : <button className="sidebar-item-main" aria-expanded={!one.collapsed} aria-controls={`folder-${one.id}`} onClick={() => void attempt(() => onChange({ action: 'fold-folder', id: one.id, collapsed: !one.collapsed }))}><ChevronDown size={12} className={one.collapsed ? 'folded' : ''} aria-hidden /><Folder size={14} aria-hidden /><span>{one.name}</span><small>{itemRows(one.id).length}</small></button>}
        {controls({ type: 'folder', id: one.id }, one.name)}
      </div>
      <SidebarDisclosure id={`folder-${one.id}`} open={!one.collapsed}>{rows(one.id)}{dragging && itemRows(one.id).length === 0 && <div className="sidebar-folder-empty" onDragOver={event => accept(event, one.id)} onDrop={event => drop(event, one.id)}>Drop here</div>}</SidebarDisclosure>
    </div>)}
    {rows(null)}
    {dragging && layout.folders.length > 0 && <div className={`sidebar-unfile${over === 'root' ? ' sidebar-drop-target' : ''}`} onDragOver={event => accept(event, 'root')} onDrop={event => drop(event, null)}>Move out of folders</div>}
  </div>
}
