import { FolderPlus } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { t } from '../i18n.js'

interface Props { at: { x: number; y: number }; onClose(): void; onNewFolder(): void }

export function SidebarSpaceMenu({ at, onClose, onNewFolder }: Props) {
  const box = useRef<HTMLDivElement>(null), item = useRef<HTMLButtonElement>(null), origin = useRef<HTMLElement | null>(null)
  const close = () => { onClose(); if (origin.current?.isConnected) origin.current.focus() }
  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    node.style.left = `${Math.max(8, Math.min(at.x, window.innerWidth - node.offsetWidth - 8))}px`
    node.style.top = `${Math.max(8, Math.min(at.y, window.innerHeight - node.offsetHeight - 8))}px`
    origin.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    item.current?.focus()
  }, [at])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) onClose() }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() } }
    window.addEventListener('pointerdown', outside); window.addEventListener('keydown', escape)
    window.addEventListener('resize', onClose); window.addEventListener('scroll', onClose, true)
    return () => {
      window.removeEventListener('pointerdown', outside); window.removeEventListener('keydown', escape)
      window.removeEventListener('resize', onClose); window.removeEventListener('scroll', onClose, true)
    }
  }, [])
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== 'Escape' && event.key !== 'Tab') return
    event.preventDefault(); event.stopPropagation(); close()
  }
  return createPortal(<div className="sidebar-menu sidebar-organize-menu" role="dialog" aria-label={t('sidebar.create')} ref={box} onKeyDown={onKeyDown}>
    <button ref={item} data-testid="sidebar-space-new-folder" onClick={() => { onClose(); onNewFolder() }}><FolderPlus size={13} aria-hidden /><span className="sidebar-menu-label">{t('sidebar.newFolder')}</span></button>
  </div>, document.body)
}
