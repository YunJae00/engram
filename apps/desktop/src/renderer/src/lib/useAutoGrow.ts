import { useLayoutEffect, type RefObject } from 'react'

// A composer starts one line tall and follows its draft; the stylesheet's
// max-height caps it and the box scrolls inside past that. Height is reset to
// auto first so deleting lines (or sending) lets it shrink again. scrollHeight
// leaves out the border, which a border-box height must include.
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string): void {
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    // Prefer native sizing to avoid a synchronous layout read per keystroke.
    if (CSS.supports('field-sizing', 'content')) return
    box.style.height = '0px'
    box.style.height = `${box.scrollHeight}px`
  }, [ref, value])
}
