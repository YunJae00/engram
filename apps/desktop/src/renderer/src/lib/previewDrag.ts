import { useEffect, type RefObject } from 'react'

type Point = { x: number; y: number }
type Bounds = { width: number; floor: number; depth: number }
type Drag = { id: number; start: Point; last: Point; origin: Point; shown: Point; provisional?: Point; moved: boolean }

const SPACING = 30
const MIN_CARD = 44
const FIT_VARS = ['--live-fit-width', '--live-fit-stage', '--live-fit-space']
// Committed lane preferences for this renderer lifetime; a drag writes one only on release.
const positions = new Map<string, Point>()

export function clampPreview(point: Point, width: number, height: number, cardWidth: number, cardHeight: number, depth = 0): Point {
  return {
    x: Math.min(Math.max(depth, point.x), Math.max(depth, width - cardWidth)),
    y: Math.min(Math.max(depth, point.y), Math.max(depth, height - cardHeight)),
  }
}

export function fitSpacing(width: number, floor: number, stack: number, spacing = SPACING): number {
  if (stack <= 0) return 0
  return Math.max(0, Math.min(spacing, (width - MIN_CARD) / stack, (floor - MIN_CARD) / stack))
}

const same = (a: Point, b: Point) => a.x === b.x && a.y === b.y

export function usePreviewDrag(ref: RefObject<HTMLDivElement>, enabled: boolean, lane: string): void {
  useEffect(() => {
    const deck = ref.current
    const chat = deck?.parentElement
    if (!enabled || !deck || !chat) return
    const thread = chat.querySelector<HTMLElement>(':scope > .bots-thread')
    let drag: Drag | undefined
    let live = true
    const style = (name: string, value: string) => { if (deck.style.getPropertyValue(name) !== value) deck.style.setProperty(name, value) }
    const flag = (name: string, on: boolean) => { if (deck.hasAttribute(name) !== on) { if (on) deck.setAttribute(name, ''); else deck.removeAttribute(name) } }
    const shown = (): Point => ({ x: deck.offsetLeft, y: deck.offsetTop })
    const stack = () => Math.min(3, Math.max(0, Number(deck.style.getPropertyValue('--deck-depth')) || 0))
    const bounds = (): Bounds | undefined => {
      const width = chat.clientWidth, height = chat.clientHeight
      if (!width || !height) return undefined
      const floor = Math.min(thread ? thread.offsetTop + thread.offsetHeight : height, height)
      return { width, floor, depth: stack() * (parseFloat(deck.style.getPropertyValue('--live-fit-space')) || 0) }
    }
    const place = (point: Point, { width, floor, depth }: Bounds): Point => {
      const next = clampPreview(point, width, floor, deck.offsetWidth, deck.offsetHeight, depth)
      style('left', `${next.x}px`)
      style('top', `${next.y}px`)
      style('right', 'auto')
      return next
    }
    const finish = (commit: boolean, settle = true) => {
      const active = drag
      if (!active) return
      drag = undefined
      flag('data-dragging', false)
      if (commit && active.moved && active.provisional) positions.set(lane, active.provisional)
      try { if (deck.hasPointerCapture(active.id)) deck.releasePointerCapture(active.id) } catch { /* The pointer is already gone. */ }
      if (settle) layout()
    }
    const fit = (space: Bounds) => {
      const spacing = fitSpacing(space.width, space.floor, stack())
      const depth = stack() * spacing
      for (const name of FIT_VARS) style(name, '')
      const natural = { width: deck.offsetWidth, height: deck.offsetHeight }
      style('--live-fit-space', `${spacing}px`)
      style('--live-fit-width', `${Math.min(natural.width, space.width - depth)}px`)
      style('--live-fit-stage', `${Math.min(natural.height, space.floor - depth)}px`)
      return { ...space, depth }
    }
    const layout = () => {
      if (!live) return
      const space = bounds()
      if (!space) { finish(false, false); return }
      if (space.width < MIN_CARD || space.floor < MIN_CARD) { finish(false, false); flag('data-suspended', true); return }
      flag('data-suspended', false)
      const fitted = fit(space)
      const requested = drag ? drag.provisional ?? drag.shown : positions.get(lane)
      if (requested) {
        const next = place(requested, fitted)
        if (drag) { drag.origin = next; drag.start = drag.last; drag.shown = next; if (drag.provisional) drag.provisional = next }
        return
      }
      for (const name of ['left', 'top', 'right']) style(name, '')
      const anchor = shown()
      const next = clampPreview(anchor, fitted.width, fitted.floor, deck.offsetWidth, deck.offsetHeight, fitted.depth)
      if (!same(anchor, next)) place(next, fitted)
    }
    const down = (event: PointerEvent) => {
      if (drag || !event.isPrimary || event.button !== 0 || deck.hasAttribute('data-suspended')) return
      if (event.target instanceof Element && event.target.closest('button, input, textarea, a')) return
      try { deck.setPointerCapture(event.pointerId) } catch { return }
      if (!deck.hasPointerCapture(event.pointerId)) return
      const point = { x: event.clientX, y: event.clientY }
      drag = { id: event.pointerId, start: point, last: point, origin: shown(), shown: shown(), moved: false }
      flag('data-dragging', true)
      deck.focus({ preventScroll: true })
    }
    const move = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return
      drag.last = { x: event.clientX, y: event.clientY }
      const space = bounds()
      if (!space) return
      const next = place({ x: drag.origin.x + drag.last.x - drag.start.x, y: drag.origin.y + drag.last.y - drag.start.y }, space)
      if (!same(next, drag.shown)) drag.moved = true
      drag.shown = next
      drag.provisional = next
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
    deck.addEventListener('keydown', key)
    window.addEventListener('blur', blur)
    return () => {
      live = false
      finish(false, false)
      resize.disconnect()
      depthWatch.disconnect()
      deck.removeEventListener('pointerdown', down)
      deck.removeEventListener('pointermove', move)
      deck.removeEventListener('pointerup', up)
      deck.removeEventListener('pointercancel', cancel)
      deck.removeEventListener('lostpointercapture', cancel)
      deck.removeEventListener('keydown', key)
      window.removeEventListener('blur', blur)
    }
  }, [ref, enabled, lane])
}
