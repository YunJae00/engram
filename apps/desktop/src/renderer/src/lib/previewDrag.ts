import { useEffect, type RefObject } from 'react'

type Point = { x: number; y: number }
type Space = { width: number; floor: number; depth: number; slot: Point; card: { width: number; height: number } }
type Drag = { id: number; start: Point; last: Point; origin: Point; shown: Point; moved: boolean }

const SPACING = 30
// Committed lane preferences for this renderer lifetime; a drag writes one only on release.
const positions = new Map<string, Point>()

export function clampPreview(point: Point, width: number, height: number, cardWidth: number, cardHeight: number, depth = 0): Point {
  return {
    x: Math.min(Math.max(depth, point.x), Math.max(depth, width - cardWidth)),
    y: Math.min(Math.max(depth, point.y), Math.max(depth, height - cardHeight)),
  }
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y

export function usePreviewDrag(ref: RefObject<HTMLDivElement>, enabled: boolean, lane: string): void {
  useEffect(() => {
    const deck = ref.current
    const chat = deck?.parentElement
    if (!enabled || !deck || !chat) return
    const thread = chat.querySelector<HTMLElement>(':scope > .bots-thread')
    let drag: Drag | undefined
    let offset: Point = { x: 0, y: 0 }
    let live = true
    const flag = (name: string, on: boolean) => { if (deck.hasAttribute(name) !== on) { if (on) deck.setAttribute(name, ''); else deck.removeAttribute(name) } }
    const stack = () => Math.min(3, Math.max(0, Number(deck.style.getPropertyValue('--deck-depth')) || 0))
    const measure = (): Space | undefined => {
      const width = chat.clientWidth, height = chat.clientHeight
      if (!width || !height || !deck.offsetWidth || !deck.offsetHeight) return undefined
      const floor = Math.min(thread ? thread.offsetTop + thread.offsetHeight : height, height)
      return { width, floor, depth: stack() * SPACING, slot: { x: deck.offsetLeft, y: deck.offsetTop }, card: { width: deck.offsetWidth, height: deck.offsetHeight } }
    }
    const shift = (next: Point) => {
      if (same(next, offset)) return
      offset = next
      if (next.x === 0 && next.y === 0) deck.style.removeProperty('translate')
      else deck.style.setProperty('translate', `${next.x}px ${next.y}px`)
    }
    const place = (point: Point, space: Space): Point => {
      const next = clampPreview(point, space.width, space.floor, space.card.width, space.card.height, space.depth)
      shift({ x: next.x - space.slot.x, y: next.y - space.slot.y })
      return next
    }
    const finish = (commit: boolean, settle = true) => {
      const active = drag
      if (!active) return
      drag = undefined
      flag('data-dragging', false)
      if (commit && active.moved) positions.set(lane, active.shown)
      try { if (deck.hasPointerCapture(active.id)) deck.releasePointerCapture(active.id) } catch { /* The pointer is already gone. */ }
      if (settle) layout()
    }
    const layout = () => {
      if (!live) return
      const space = measure()
      if (!space) { finish(false, false); return }
      const requested = drag ? drag.shown : positions.get(lane)
      if (!requested) { shift({ x: 0, y: 0 }); return }
      const next = place(requested, space)
      if (drag) { drag.origin = next; drag.start = drag.last; drag.shown = next }
    }
    const down = (event: PointerEvent) => {
      if (drag || !event.isPrimary || event.button !== 0) return
      if (event.target instanceof Element && event.target.closest('button, input, textarea, a')) return
      const space = measure()
      if (!space) return
      try { deck.setPointerCapture(event.pointerId) } catch { return }
      if (!deck.hasPointerCapture(event.pointerId)) return
      const point = { x: event.clientX, y: event.clientY }
      const shown = { x: space.slot.x + offset.x, y: space.slot.y + offset.y }
      drag = { id: event.pointerId, start: point, last: point, origin: shown, shown, moved: false }
      flag('data-dragging', true)
      deck.focus({ preventScroll: true })
    }
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return
      drag.last = { x: event.clientX, y: event.clientY }
      const space = measure()
      if (!space) return
      const next = place({ x: drag.origin.x + drag.last.x - drag.start.x, y: drag.origin.y + drag.last.y - drag.start.y }, space)
      if (!same(next, drag.shown)) drag.moved = true
      drag.shown = next
    }
    const up = (event: PointerEvent) => { if (drag?.id === event.pointerId) finish(true) }
    const cancel = (event: PointerEvent) => { if (drag?.id === event.pointerId) finish(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag) { finish(false); event.stopPropagation() } }
    const blur = () => finish(false)
    let depth = deck.style.getPropertyValue('--deck-depth')
    const depthWatch = new MutationObserver(() => {
      const next = deck.style.getPropertyValue('--deck-depth')
      if (next === depth) return
      depth = next
      layout()
    })
    const resize = new ResizeObserver(layout)
    layout()
    depthWatch.observe(deck, { attributes: true, attributeFilter: ['style'] })
    resize.observe(chat)
    resize.observe(deck)
    if (thread) resize.observe(thread)
    deck.addEventListener('pointerdown', down)
    deck.addEventListener('pointermove', move)
    deck.addEventListener('pointerup', up)
    deck.addEventListener('pointercancel', cancel)
    deck.addEventListener('lostpointercapture', cancel)
    window.addEventListener('keydown', key, true)
    window.addEventListener('blur', blur)
    return () => {
      live = false
      finish(false, false)
      resize.disconnect()
      depthWatch.disconnect()
      shift({ x: 0, y: 0 })
      deck.removeEventListener('pointerdown', down)
      deck.removeEventListener('pointermove', move)
      deck.removeEventListener('pointerup', up)
      deck.removeEventListener('pointercancel', cancel)
      deck.removeEventListener('lostpointercapture', cancel)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', blur)
    }
  }, [ref, enabled, lane])
}
