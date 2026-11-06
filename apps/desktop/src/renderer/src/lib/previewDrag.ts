import { useEffect, type RefObject } from 'react'

type Point = { x: number; y: number }
type Fit = { width: number; height: number; depth: number; step: number; floor: number; gutter: number }
type Drag = { id: number; start: Point; origin: Point; last: Point; shown: Point; moved: boolean }
const STEP = 30
const MIN_CARD = 44
const TOP = 12
const positions = new Map<string, Point>()
const FIT_VARS = ['--overlay-width', '--overlay-stage', '--overlay-step'] as const

export function clampPreview(point: Point, width: number, height: number, cardWidth: number, cardHeight: number, depth = 0): Point {
  return {
    x: Math.min(Math.max(depth, point.x), Math.max(depth, width - cardWidth)),
    y: Math.min(Math.max(depth, point.y), Math.max(depth, height - cardHeight)),
  }
}

// Spacing shrinks before the cards do, so a four-card stack still fits a short thread with usable controls.
export function fitStack(width: number, floor: number, count: number): { step: number; depth: number } {
  const step = count ? Math.max(0, Math.min(STEP, (width - MIN_CARD) / count, (floor - MIN_CARD) / count)) : STEP
  return { step, depth: count * step }
}

function setStyle(node: HTMLElement, name: string, value: string): void {
  if (node.style.getPropertyValue(name) !== value) {
    if (value) node.style.setProperty(name, value); else node.style.removeProperty(name)
  }
}

function measure(card: HTMLElement, chat: HTMLElement, thread: HTMLElement | undefined): Fit {
  const width = chat.clientWidth
  const floor = Math.min(thread ? thread.offsetTop + thread.offsetHeight : chat.clientHeight, chat.clientHeight)
  const count = Math.min(3, Math.max(0, Number(card.style.getPropertyValue('--deck-depth')) || 0))
  const { step, depth } = fitStack(width, floor, count)
  const inline = { left: card.style.left, top: card.style.top, right: card.style.right }
  for (const name of FIT_VARS) card.style.removeProperty(name)
  card.style.left = ''; card.style.top = ''; card.style.right = ''
  const natural = { width: card.offsetWidth, height: card.offsetHeight, gutter: width - card.offsetLeft - card.offsetWidth }
  card.style.left = inline.left; card.style.top = inline.top; card.style.right = inline.right
  setStyle(card, '--overlay-step', `${step}px`)
  setStyle(card, '--overlay-width', `${Math.max(0, Math.min(natural.width, width - depth))}px`)
  setStyle(card, '--overlay-stage', `${Math.max(0, Math.min(natural.height, floor - depth))}px`)
  return { width: card.offsetWidth, height: card.offsetHeight, depth, step, floor, gutter: natural.gutter }
}

export function usePreviewDrag(ref: RefObject<HTMLDivElement>, enabled: boolean, lane: string): void {
  useEffect(() => {
    const card = ref.current
    const chat = card?.parentElement
    if (!enabled || !card || !chat) return
    const found = chat.querySelector(':scope > .bots-thread')
    const thread = found instanceof HTMLElement ? found : undefined
    let alive = true
    let drag: Drag | undefined
    let fit = measure(card, chat, thread)
    const place = (point: Point, fit: Fit): Point => {
      const next = clampPreview(point, chat.clientWidth, fit.floor, fit.width, fit.height, fit.depth)
      setStyle(card, 'left', `${next.x}px`)
      setStyle(card, 'top', `${next.y}px`)
      setStyle(card, 'right', 'auto')
      return next
    }
    const anchor = () => { setStyle(card, 'left', ''); setStyle(card, 'top', ''); setStyle(card, 'right', '') }
    const end = () => {
      if (!drag) return
      const { id } = drag
      drag = undefined
      card.removeAttribute('data-dragging')
      try { if (card.hasPointerCapture(id)) card.releasePointerCapture(id) } catch { /* The pointer is already gone. */ }
    }
    const layout = () => {
      if (!alive) return
      if (!chat.clientWidth || !chat.clientHeight) { end(); return }
      fit = measure(card, chat, thread)
      const suspended = chat.clientWidth < MIN_CARD || fit.floor < MIN_CARD
      if (suspended) { end(); card.setAttribute('data-suspended', ''); return }
      card.removeAttribute('data-suspended')
      if (drag) {
        drag.shown = place(drag.shown, fit)
        drag.origin = drag.shown
        drag.start = drag.last
        return
      }
      const saved = positions.get(lane)
      if (saved) { place(saved, fit); return }
      const fallback = { x: chat.clientWidth - fit.gutter - fit.width, y: TOP + fit.depth }
      const fits = fallback.x >= fit.depth && fallback.y + fit.height <= fit.floor
      if (fits) anchor(); else place(fallback, fit)
    }
    const down = (event: PointerEvent) => {
      if (drag || !event.isPrimary || event.button !== 0 || card.hasAttribute('data-suspended')) return
      if ((event.target as Element).closest('button, input, textarea, a')) return
      try { card.setPointerCapture(event.pointerId) } catch { return }
      const at = { x: event.clientX, y: event.clientY }
      const origin = { x: card.offsetLeft, y: card.offsetTop }
      drag = { id: event.pointerId, start: at, last: at, origin, shown: origin, moved: false }
      card.setAttribute('data-dragging', '')
      card.focus({ preventScroll: true })
    }
    const pointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return
      drag.last = { x: event.clientX, y: event.clientY }
      drag.moved ||= drag.last.x !== drag.start.x || drag.last.y !== drag.start.y
      drag.shown = place({ x: drag.origin.x + drag.last.x - drag.start.x, y: drag.origin.y + drag.last.y - drag.start.y }, fit)
    }
    const up = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return
      if (drag.moved) positions.set(lane, drag.shown)
      end()
      layout()
    }
    const cancel = (event: PointerEvent) => { if (drag && drag.id === event.pointerId) { end(); layout() } }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag) { end(); layout(); event.stopPropagation() } }
    const blur = () => { if (drag) { end(); layout() } }
    layout()
    let depth = card.style.getPropertyValue('--deck-depth')
    const stack = new MutationObserver(() => {
      const next = card.style.getPropertyValue('--deck-depth')
      if (next === depth) return
      depth = next
      layout()
    })
    stack.observe(card, { attributes: true, attributeFilter: ['style'] })
    const resize = new ResizeObserver(layout)
    resize.observe(chat)
    resize.observe(card)
    if (thread) resize.observe(thread)
    card.addEventListener('pointerdown', down)
    card.addEventListener('pointermove', pointerMove)
    card.addEventListener('pointerup', up)
    card.addEventListener('pointercancel', cancel)
    card.addEventListener('lostpointercapture', cancel)
    card.addEventListener('keydown', key)
    window.addEventListener('blur', blur)
    return () => {
      alive = false
      end()
      resize.disconnect()
      stack.disconnect()
      card.removeEventListener('pointerdown', down)
      card.removeEventListener('pointermove', pointerMove)
      card.removeEventListener('pointerup', up)
      card.removeEventListener('pointercancel', cancel)
      card.removeEventListener('lostpointercapture', cancel)
      card.removeEventListener('keydown', key)
      window.removeEventListener('blur', blur)
    }
  }, [ref, enabled, lane])
}
