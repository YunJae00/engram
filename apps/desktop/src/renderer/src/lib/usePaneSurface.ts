import { useEffect, useRef } from 'react'

export function usePaneSurface(onClose: () => void) {
  const ref = useRef<HTMLElement>(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const panel = ref.current, previous = document.activeElement as HTMLElement | null
    if (!panel) return
    const siblings = [...(panel.parentElement?.children ?? [])].filter((node): node is HTMLElement => node instanceof HTMLElement && node !== panel).map(node => ({ node, inert: node.inert }))
    siblings.forEach(({ node }) => { node.inert = true })
    panel.querySelector<HTMLElement>('button, input, textarea')?.focus()
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented && panel.contains(event.target as Node)) { event.stopPropagation(); close.current() } }
    window.addEventListener('keydown', key)
    return () => {
      window.removeEventListener('keydown', key)
      siblings.forEach(({ node, inert }) => { node.inert = inert })
      if (previous?.isConnected) previous.focus()
    }
  }, [])
  return ref
}
