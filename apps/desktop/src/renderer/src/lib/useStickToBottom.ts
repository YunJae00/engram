import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

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
  const observed = useRef<HTMLElement | null>(null)
  const disconnect = useRef<(() => void) | null>(null)
  // A thread can mount after its data loads, or replace the previous chat.
  // The ref object stays the same even when the element it points to changes.
  useLayoutEffect(() => {
    const list = ref.current
    if (observed.current === list) return
    disconnect.current?.()
    disconnect.current = null
    observed.current = list
    if (!list) return
    pinned.current = true
    let frame = 0
    const watch = (): void => {
      pinned.current = list.scrollHeight - list.scrollTop - list.clientHeight <= AT_FOOT
    }
    list.addEventListener('scroll', watch, { passive: true })
    // Content that grows on its own (a picture arriving, a block folding
    // open) moves the foot without anyone scrolling.
    const follow = (): void => {
      if (!pinned.current || frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        if (pinned.current) list.scrollTop = list.scrollHeight
      })
    }
    const grew = typeof ResizeObserver === 'function' ? new ResizeObserver(follow) : null
    grew?.observe(list)
    // The list's own box does not change when its content grows; what grows
    // is inside it. Every node added or word written under it moves the
    // foot, and a pinned reader is taken along.
    const changed = typeof MutationObserver === 'function' ? new MutationObserver(follow) : null
    changed?.observe(list, { childList: true, subtree: true, characterData: true })
    follow()
    disconnect.current = () => {
      list.removeEventListener('scroll', watch)
      grew?.disconnect()
      changed?.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  })
  useEffect(() => () => {
    disconnect.current?.()
    disconnect.current = null
    observed.current = null
  }, [ref])
  useLayoutEffect(() => {
    const list = ref.current
    if (!list || !pinned.current) return
    list.scrollTop = list.scrollHeight
  }, [ref, changes])
}
