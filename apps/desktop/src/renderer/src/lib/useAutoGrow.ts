import { useLayoutEffect, type RefObject } from 'react'

export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    if (CSS.supports('field-sizing', 'content')) return
    box.style.height = '0px'
    box.style.height = `${box.scrollHeight}px`
  }, [ref, value])
}
