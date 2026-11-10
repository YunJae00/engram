import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { loadEarlierTurns } from './cometThreadsLive.js'

const AT_TOP = 4

// Reaching the top of the thread reads one earlier page; the bubble at the top edge keeps its screen position.
export function useLoadEarlier(ref: RefObject<HTMLElement | null>, botId: string | null, older: number): void {
  const anchor = useRef<{ botId: string; element: Element; top: number } | null>(null)
  useEffect(() => {
    const list = ref.current
    if (!list || !botId) return
    const prior = list.style.overflowAnchor
    // The layout effect below corrects the position; native anchoring would correct it a second time.
    list.style.overflowAnchor = 'none'
    let armed = true
    const capture = () => {
      const edge = list.getBoundingClientRect().top
      for (const element of list.querySelectorAll('.bubble-msg')) {
        const top = element.getBoundingClientRect().top
        if (top >= edge) { anchor.current = { botId, element, top }; return }
      }
    }
    const scroll = () => {
      if (list.scrollTop > AT_TOP) { armed = true; return }
      if (!armed) return
      armed = false
      void loadEarlierTurns(botId, capture)
    }
    list.addEventListener('scroll', scroll, { passive: true })
    return () => {
      list.removeEventListener('scroll', scroll)
      list.style.overflowAnchor = prior
      anchor.current = null
    }
  }, [ref, botId])
  useLayoutEffect(() => {
    const held = anchor.current
    anchor.current = null
    const list = ref.current
    if (!held || !list || held.botId !== botId) return
    let frames = 0, frame = 0
    const hold = () => {
      if (!held.element.isConnected) return
      list.scrollTop += held.element.getBoundingClientRect().top - held.top
      // Skipped bubbles above (content-visibility) take their real height a frame or two after the commit.
      if (++frames < 8) frame = requestAnimationFrame(hold)
    }
    hold()
    return () => cancelAnimationFrame(frame)
  }, [ref, botId, older])
}
