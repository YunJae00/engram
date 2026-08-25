import { useLayoutEffect, type RefObject } from 'react'

// A composer starts one line tall and follows its draft; the stylesheet's
// max-height caps it and the box scrolls inside past that. Height is reset to
// auto first so deleting lines (or sending) lets it shrink again. scrollHeight
// leaves out the border, which a border-box height must include.
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    box.style.height = 'auto'
    const border = box.offsetHeight - box.clientHeight
    box.style.height = `${box.scrollHeight + border}px`
  }, [ref, value])
}
