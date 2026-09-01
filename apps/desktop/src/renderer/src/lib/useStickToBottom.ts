import { useEffect, useRef, type RefObject } from 'react'

// A conversation follows its newest line unless the person has gone looking
// at an older one. Deciding that from the distance to the bottom AFTER the
// new words arrived was the bug: a long paragraph lands in one go, the
// distance is suddenly large, and the thread stops following exactly when
// there is most to follow. So what the person is doing is remembered - at
// the foot of the thread, or reading further up - and only their own scroll
// changes it.

// How far from the foot still counts as being at it.
const AT_FOOT = 48

export function useStickToBottom(ref: RefObject<HTMLElement | null>, changes: unknown): void {
  const pinned = useRef(true)
  useEffect(() => {
    const list = ref.current
    if (!list) return
    const watch = (): void => {
      pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight <= AT_FOOT
    }
    list.addEventListener('scroll', watch, { passive: true })
    // Content that grows on its own (a picture arriving, a block folding
    // open) moves the foot without anyone scrolling.
    const grew = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (pinned.current) list.scrollTop = list.scrollHeight
    }) : null
    grew?.observe(list)
    return () => {
      list.removeEventListener('scroll', watch)
      grew?.disconnect()
    }
  }, [ref])
  useEffect(() => {
    const list = ref.current
    if (!list || !pinned.current) return
    list.scrollTop = list.scrollHeight
  }, [ref, changes])
}
