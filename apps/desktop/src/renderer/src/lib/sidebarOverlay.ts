import { useEffect } from 'react'
import { flushSync } from 'react-dom'
import { OVERLAY_SELECTOR } from './nativeSurfaces.js'

const NARROW = '(max-width: 900px)'
const COMPOSERS = '.chat-write textarea, .dev-composer > textarea'
const FIELDS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'
const LAYERS = `${OVERLAY_SELECTOR}, :popover-open, .bots-memory, .mission-chooser [data-open="true"]`

function usable(element: HTMLTextAreaElement): boolean {
  return !element.disabled && !element.readOnly && !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.getClientRects().length > 0
}

export function dismissSidebar(close: () => void): void {
  flushSync(close)
  const composer = [...document.querySelectorAll<HTMLTextAreaElement>(COMPOSERS)].find(usable)
  ;(composer ?? document.querySelector<HTMLElement>('[data-testid="app-sidebar-open"]'))?.focus()
}

// A field outside the sidebar owns its own Esc (rename, address draft), even when its handler does not prevent default.
function ownedByField(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(FIELDS) && !target.closest('.app-sidebar') && !target.matches(COMPOSERS)
}

export function useSidebarEscape(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229) return
      if (!matchMedia(NARROW).matches || ownedByField(event.target) || document.querySelector(LAYERS)) return
      event.preventDefault()
      dismissSidebar(close)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [open, close])
}
