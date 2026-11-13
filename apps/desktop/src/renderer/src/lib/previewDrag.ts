import { useLayoutEffect, type RefObject } from 'react'

type Point = { x: number; y: number }
type Bounds = { width: number; room: number; floor: number; depth: number }
type Drag = { id: number; start: Point; last: Point; origin: Point; shown: Point; provisional?: Point; moved: boolean }

const SPACING = 30
const MINI_SPACING = 12
const MIN_CARD = 44
const DOCK_INSET = 12
const TEXT_LANE = 120
const CLEAR_GAP = 12
const CLEAR_VAR = '--live-clear-right'
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

export function usePreviewDrag(ref: RefObject<HTMLDivElement>, enabled: boolean, lane: string, draggable: boolean): void {
  useLayoutEffect(() => {
    const deck = ref.current
    const chat = deck?.closest<HTMLElement>('.bots-chat, .mini-chat')
    if (!enabled || !deck || !chat) return
    const thread = chat.querySelector<HTMLElement>(':scope > .bots-thread, :scope > .mini-chat-thread')
    const step = draggable ? SPACING : MINI_SPACING
    let drag: Drag | undefined
    let live = true
    const style = (name: string, value: string) => { if (deck.style.getPropertyValue(name) !== value) deck.style.setProperty(name, value) }
    const flag = (name: string, on: boolean) => { if (deck.hasAttribute(name) !== on) { if (on) deck.setAttribute(name, ''); else deck.removeAttribute(name) } }
    const shown = (): Point => ({ x: deck.offsetLeft, y: deck.offsetTop })
    const stack = () => Math.min(3, Math.max(0, Number(deck.style.getPropertyValue('--deck-depth')) || 0))
    const spaced = () => stack() * (parseFloat(deck.style.getPropertyValue('--live-fit-space')) || 0)
    // The docked deck leaves chat text a readable lane on its left: the thread's own left padding plus TEXT_LANE and a gap.
    const textLane = () => (thread ? parseFloat(getComputedStyle(thread).paddingLeft) || 0 : 0) + TEXT_LANE + CLEAR_GAP
    const bounds = (docked = false): Bounds | undefined => {
      const width = chat.clientWidth, height = chat.clientHeight
      if (!width || !height) return undefined
      const floor = Math.min(thread ? thread.offsetTop + thread.offsetHeight : height, height)
      if (docked) return { width, room: width - textLane() - DOCK_INSET, floor: floor - DOCK_INSET, depth: 0 }
      return { width, room: width, floor, depth: spaced() }
    }
    // Only the docked deck pushes bubbles left; a card the person dragged floats over the chat as before.
    const clear = () => {
      if (!thread || deck.hasAttribute('data-suspended') || deck.hasAttribute('data-floating')) { chat.style.removeProperty(CLEAR_VAR); return }
      const value = `${Math.ceil(chat.clientWidth - (deck.offsetLeft - spaced()) + CLEAR_GAP)}px`
      if (chat.style.getPropertyValue(CLEAR_VAR) !== value) chat.style.setProperty(CLEAR_VAR, value)
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
      const spacing = fitSpacing(space.room, space.floor, stack(), step)
      const depth = stack() * spacing
      style('--live-fit-space', `${spacing}px`)
      style('--live-fit-width', `${Math.max(0, space.room - depth)}px`)
      style('--live-fit-stage', `${Math.max(0, space.floor - depth)}px`)
      return { ...space, depth }
    }
    // The CSS anchor docks the deck at the chat's top inset over the thread; the fit keeps its bottom at or above the thread floor.
    const dock = () => {
      for (const name of ['left', 'top', 'right']) style(name, '')
      flag('data-floating', false)
      const space = bounds(true)
      const room = !!space && space.room >= MIN_CARD && space.floor >= MIN_CARD
      flag('data-suspended', !room)
      if (space && room) fit(space)
    }
    // An untouched deck stays docked at the top right; only a moved drag or a committed spot floats it over the chat.
    const layout = () => {
      if (!live) return
      const requested = !draggable ? undefined : drag?.moved ? drag.provisional ?? drag.shown : positions.get(lane)
      if (!requested) { dock(); clear(); return }
      flag('data-floating', true)
      const space = bounds()
      if (!space) { finish(false, false); clear(); return }
      if (space.room < MIN_CARD || space.floor < MIN_CARD) { finish(false, false); flag('data-suspended', true); clear(); return }
      flag('data-suspended', false)
      const next = place(requested, fit(space))
      clear()
      if (drag?.moved) { drag.origin = next; drag.start = drag.last; drag.shown = next; drag.provisional = next }
    }
    const down = (event: PointerEvent) => {
      if (!draggable || drag || !event.isPrimary || event.button !== 0 || deck.hasAttribute('data-suspended')) return
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
      const target = { x: drag.origin.x + drag.last.x - drag.start.x, y: drag.origin.y + drag.last.y - drag.start.y }
      if (!drag.moved) {
        if (same(target, drag.origin)) return
        drag.moved = true
        drag.provisional = target
        layout()
        return
      }
      const space = bounds()
      if (!space) return
      drag.shown = place(target, space)
      drag.provisional = drag.shown
      clear()
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
      chat.style.removeProperty(CLEAR_VAR)
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
  }, [ref, enabled, lane, draggable])
}
