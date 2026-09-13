import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

type Message = { role: string; streaming?: boolean }
const AT_FOOT = 48

export function useStickToBottom(ref: RefObject<HTMLElement | null>, messages: Message[], thread?: string | null): void {
  const state = useRef<{ list: HTMLElement; thread?: string | null; users: number; follow(fresh?: boolean): void; disconnect(): void }>()
  useLayoutEffect(() => {
    const list = ref.current
    const users = messages.filter(message => message.role === 'user').length
    if (state.current?.list !== list || state.current?.thread !== thread) {
      state.current?.disconnect()
      state.current = undefined
      if (!list) return
      let pinned = true
      let frame = 0
      let applied = list.scrollTop
      let started = 0
      let from = 0
      const reduced = matchMedia('(prefers-reduced-motion: reduce)')
      const bottom = () => Math.max(0, list.scrollHeight - list.clientHeight)
      const stop = () => { pinned = false; cancelAnimationFrame(frame); frame = 0 }
      const tick = (now: number) => {
        frame = 0
        if (!pinned) return
        const progress = reduced.matches ? 1 : Math.max(0, Math.min(1, (now - started) / 280))
        const destination = bottom()
        list.scrollTop = from + (destination - from) * (1 - Math.pow(1 - progress, 3))
        applied = list.scrollTop
        if (progress < 1) frame = requestAnimationFrame(tick)
      }
      const follow = (fresh = false) => {
        if (fresh) pinned = true
        if (!pinned || frame) return
        from = list.scrollTop
        applied = from
        if (Math.abs(bottom() - from) < 1) return
        started = performance.now()
        frame = requestAnimationFrame(tick)
      }
      const scroll = () => {
        // Layout and our animation must not be mistaken for a person scrolling away.
        if (Math.abs(list.scrollTop - applied) < 1) return
        const atFoot = bottom() - list.scrollTop <= AT_FOOT
        if (list.scrollTop < applied && !atFoot) stop()
        if (atFoot) pinned = true
        applied = list.scrollTop
      }
      const wheel = (event: WheelEvent) => { if (event.deltaY < 0) stop() }
      const key = (event: KeyboardEvent) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) stop() }
      const touch = () => stop()
      list.addEventListener('scroll', scroll, { passive: true })
      list.addEventListener('wheel', wheel, { passive: true })
      list.addEventListener('touchstart', touch, { passive: true })
      list.addEventListener('keydown', key)
      const resized = new ResizeObserver(() => follow())
      const watchChildren = () => {
        resized.disconnect()
        resized.observe(list)
        for (const child of list.children) resized.observe(child)
      }
      const changed = new MutationObserver(records => { if (records.some(record => record.type === 'childList' && record.target === list)) watchChildren(); follow() })
      changed.observe(list, { childList: true, subtree: true, characterData: true })
      watchChildren()
      list.scrollTop = bottom()
      applied = list.scrollTop
      state.current = { list, thread, users, follow, disconnect: () => {
        cancelAnimationFrame(frame)
        resized.disconnect(); changed.disconnect()
        list.removeEventListener('scroll', scroll)
        list.removeEventListener('wheel', wheel)
        list.removeEventListener('touchstart', touch)
        list.removeEventListener('keydown', key)
      } }
    }
    const current = state.current
    if (!current) return
    const fresh = users > current.users && messages.some(message => message.streaming)
    current.users = users
    current.follow(fresh)
  })
  useEffect(() => () => { state.current?.disconnect(); state.current = undefined }, [])
}
