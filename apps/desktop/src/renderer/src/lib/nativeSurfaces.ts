import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { NativeSurfaceDto } from '../../../shared/types.js'

let enabled: Promise<boolean> | undefined
export function useNativeBrowser(): boolean {
  const [value, setValue] = useState(false)
  useEffect(() => {
    let alive = true
    enabled ??= api.nativeEnabled().catch(() => false)
    void enabled.then((native) => { if (alive) setValue(native) })
    return () => { alive = false }
  }, [])
  return value
}

const surfaces = new Map<HTMLElement, string>()
let timer: ReturnType<typeof setInterval> | undefined
let last = ''
let sent = 0
let changes: MutationObserver | undefined
let sizes: ResizeObserver | undefined
let frame: number | undefined

function schedule(): void {
  frame ??= requestAnimationFrame(() => { frame = undefined; measure() })
}

function focusShell(event: Event): void {
  if (!(event.target instanceof Element) || event.target.closest('[data-testid="native-browser-surface"]')) return
  api.nativeFocusShell()
}

function scroll(event: Event): void {
  // A sibling scroller cannot move a browser surface.
  if (event.target === document || [...surfaces.keys()].some(element => event.target instanceof Element && event.target.contains(element))) schedule()
}

function measure(): void {
  const result: NativeSurfaceDto[] = []
  const overlays = [...document.querySelectorAll<HTMLElement>('dialog[open], [role="alertdialog"], [aria-modal="true"], [role="menu"], [role="dialog"], .brief-overlay, .sheet-overlay, .workspace-menu, .help-panel, .mission-add-menu, .tour-overlay, .computer-status')]
  // Occlusion by another app is not a layout change. Native child windows
  // already follow their owner; unmounting them here flashes on task switching.
  for (const [element, lane] of surfaces) {
    const full = element.getBoundingClientRect()
    let left = Math.max(0, full.left), top = Math.max(0, full.top)
    let right = Math.min(innerWidth, full.right), bottom = Math.min(innerHeight, full.bottom)
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent)
      const box = parent.getBoundingClientRect()
      if (/hidden|clip|auto|scroll/.test(style.overflowX)) { left = Math.max(left, box.left + parent.clientLeft); right = Math.min(right, box.left + parent.clientLeft + parent.clientWidth) }
      if (/hidden|clip|auto|scroll/.test(style.overflowY)) { top = Math.max(top, box.top + parent.clientTop); bottom = Math.min(bottom, box.top + parent.clientTop + parent.clientHeight) }
    }
    const rect = { x: left, y: top, left, top, right, bottom, width: right - left, height: bottom - top }
    if (rect.width < 16 || rect.height < 16) continue
    if (element.closest('[hidden], [inert]')) continue
    if (overlays.some((overlay) => {
      if (overlay.contains(element)) return false
      if (getComputedStyle(overlay).visibility === 'hidden') return false
      const box = overlay.getBoundingClientRect()
      return box.width > 0 && box.height > 0 && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top
    })) continue
    // Native child windows cannot sit below an HTML menu or modal. With no
    // overlay open there is nothing that can occlude one, so the nine hit-tests
    // (forced layout ×9 per surface, on every scroll frame) are pure cost.
    // ponytail: a non-overlay element transiently over the surface (a tooltip)
    // won't hide it while no menu is open; add a cheap single-point probe if
    // that ever matters.
    const clear = overlays.length === 0 || [0.02, 0.5, 0.98].every((fx) => [0.02, 0.5, 0.98].every((fy) => {
      const top = document.elementFromPoint(rect.x + rect.width * fx, rect.y + rect.height * fy)
      return top === element || (top !== null && element.contains(top))
    }))
    if (clear) result.push({ lane, x: full.x, y: full.y, width: full.width, height: full.height, clip: { x: left - full.x, y: top - full.y, width: rect.width, height: rect.height } })
  }
  const next = JSON.stringify(result)
  if (next === last && Date.now() - sent < 1000) return
  last = next
  sent = Date.now()
  void api.nativeLayout(result).catch(() => { last = '' })
}

export function mountNativeSurface(element: HTMLElement, lane: string): () => void {
  surfaces.set(element, lane)
  if (!timer) {
    // Keep the native host's lease alive without polling layout at frame rate.
    timer = setInterval(measure, 1000)
    document.addEventListener('pointerdown', focusShell, true)
    document.addEventListener('focusin', focusShell, true)
    changes = new MutationObserver(records => {
      // Status text and list reordering cannot move the adjacent browser.
      // Portalled menus and dialogs remain observed at the document level.
      if (records.some(record => !(record.target instanceof Element) || !record.target.closest('.sidebar-scroll, .sidebar-footer'))) schedule()
    })
    changes.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'inert', 'role', 'open'] })
    sizes = new ResizeObserver(schedule)
    window.addEventListener('focus', measure)
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', scroll, true)
    document.addEventListener('transitionend', schedule, true)
  }
  sizes?.observe(element)
  measure()
  return () => {
    surfaces.delete(element)
    sizes?.unobserve(element)
    measure()
    if (!surfaces.size) {
      clearInterval(timer); timer = undefined
      document.removeEventListener('pointerdown', focusShell, true)
      document.removeEventListener('focusin', focusShell, true)
      changes?.disconnect(); changes = undefined
      sizes?.disconnect(); sizes = undefined
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      window.removeEventListener('focus', measure)
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', scroll, true)
      document.removeEventListener('transitionend', schedule, true)
    }
  }
}
