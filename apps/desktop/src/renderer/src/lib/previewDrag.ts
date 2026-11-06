import { useEffect, type RefObject } from 'react'

type Point = { x: number; y: number }
const positions = new Map<string, Point>()
export function clampPreview(point: Point, width: number, height: number, cardWidth: number, cardHeight: number, depth = 0): Point {
  return {
    x: Math.min(Math.max(depth, point.x), Math.max(depth, width - cardWidth)),
    y: Math.min(Math.max(depth, point.y), Math.max(depth, height - cardHeight)),
  }
}

export function usePreviewDrag(ref: RefObject<HTMLDivElement>, enabled: boolean, identity: string): void {
  useEffect(() => {
    const card = ref.current
    const chat = card?.parentElement
    if (!enabled || !card || !chat) return
    // The composer stacks above the card, so the card stays over the thread that follows it.
    const thread = card.nextElementSibling instanceof HTMLElement ? card.nextElementSibling : undefined
    let drag: { id: number; start: Point; origin: Point; saved?: Point } | undefined
    const position = (): Point => ({ x: card.offsetLeft, y: card.offsetTop })
    const move = (point: Point): Point | undefined => {
      if (!chat.clientWidth || !chat.clientHeight || !card.offsetWidth || !card.offsetHeight) return undefined
      const depth = Number(card.style.getPropertyValue('--deck-depth')) * 30
      const floor = thread ? thread.offsetTop + thread.offsetHeight : chat.clientHeight
      const next = clampPreview(point, chat.clientWidth, floor, card.offsetWidth, card.offsetHeight, depth)
      card.style.left = `${next.x}px`
      card.style.top = `${next.y}px`
      card.style.right = 'auto'
      return next
    }
    const finish = (cancel: boolean) => {
      if (!drag) return
      const { id, saved } = drag
      drag = undefined
      if (cancel) {
        if (saved) { positions.set(identity, saved); move(saved) }
        else {
          positions.delete(identity)
          card.style.left = ''; card.style.top = ''; card.style.right = ''
        }
      }
      card.removeAttribute('data-dragging')
      if (card.hasPointerCapture(id)) card.releasePointerCapture(id)
    }
    const down = (event: PointerEvent) => {
      if (drag || !event.isPrimary || event.button !== 0 || (event.target as Element).closest('button, input, textarea, a')) return
      drag = { id: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: position(), saved: positions.get(identity) }
      card.setPointerCapture(event.pointerId)
      card.setAttribute('data-dragging', '')
      card.focus({ preventScroll: true })
    }
    const pointerMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return
      const next = move({ x: drag.origin.x + event.clientX - drag.start.x, y: drag.origin.y + event.clientY - drag.start.y })
      if (next) positions.set(identity, next)
    }
    const up = (event: PointerEvent) => { if (event.pointerId === drag?.id) finish(false) }
    const cancel = (event: PointerEvent) => { if (event.pointerId === drag?.id) finish(true) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && drag) { finish(true); event.stopPropagation() } }
    const blur = () => finish(true)
    const restore = () => {
      if (!chat.clientWidth || !chat.clientHeight) { finish(true); return }
      const saved = positions.get(identity)
      if (saved) move(saved)
    }
    restore()
    let depth = card.style.getPropertyValue('--deck-depth')
    const stack = new MutationObserver(() => {
      const next = card.style.getPropertyValue('--deck-depth')
      if (next === depth) return
      depth = next
      restore()
    })
    stack.observe(card, { attributes: true, attributeFilter: ['style'] })
    const resize = new ResizeObserver(restore)
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
      finish(true)
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
  }, [ref, enabled, identity])
}
