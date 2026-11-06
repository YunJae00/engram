import { useLayoutEffect, type RefObject } from 'react'

export function useChatTitlePosition(ref: RefObject<HTMLElement | null>, selectedId: string | null) {
  useLayoutEffect(() => {
    const title = ref.current
    const shell = title?.closest('.shell')
    const topbar = title?.closest<HTMLElement>('.topbar')
    if (!title || !shell || !topbar) return
    let frame = 0
    let observed: Element[] = []
    const visible = (element: Element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
    const clear = () => {
      for (const property of ['position', 'left', 'top', 'transform', 'max-width']) title.style.removeProperty(property)
    }
    const measure = () => {
      frame = 0
      const chat = Array.from(shell.querySelectorAll('.bots-main .bots-chat')).find(visible)
      const controls = Array.from(topbar.children).filter(element => !element.contains(title) && !element.classList.contains('topbar-spacer') && visible(element))
      const next = [shell, topbar, ...controls, ...(chat ? [chat] : [])]
      if (next.length !== observed.length || next.some((element, index) => element !== observed[index])) {
        observer.disconnect()
        observed = next
        for (const element of observed) observer.observe(element)
      }
      if (!chat) { clear(); return }
      const bounds = chat.getBoundingClientRect()
      const bar = topbar.getBoundingClientRect()
      const style = getComputedStyle(topbar)
      const center = bounds.left + bounds.width / 2
      let left = Math.max(8, bar.left + parseFloat(style.paddingLeft) + 8)
      let right = Math.min(innerWidth - 8, bar.right - parseFloat(style.paddingRight) - 8)
      for (const control of controls) {
        const box = control.getBoundingClientRect()
        if (box.right <= center) left = Math.max(left, box.right + 8)
        else if (box.left >= center) right = Math.min(right, box.left - 8)
        else { clear(); return }
      }
      const width = Math.min(280, 2 * Math.min(center - left, right - center))
      if (width < 48) { clear(); return }
      Object.assign(title.style, { position: 'fixed', left: `${center}px`, top: `${bar.top + bar.height / 2}px`, transform: 'translate(-50%, -50%)', maxWidth: `${width}px` })
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    const observer = new ResizeObserver(schedule)
    const mutations = new MutationObserver(schedule)
    mutations.observe(shell, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'hidden', 'aria-hidden'] })
    window.addEventListener('resize', schedule)
    measure()
    return () => {
      observer.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(frame)
      clear()
    }
  }, [ref, selectedId])
}
