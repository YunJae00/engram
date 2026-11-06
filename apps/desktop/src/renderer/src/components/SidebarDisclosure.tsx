import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import { useReducedMotion } from '../lib/motion.js'

export function SidebarDisclosure({ id, open, children, unmountOnExit = false, chatMotion = false }: { id: string; open: boolean; children: ReactNode; unmountOnExit?: boolean; chatMotion?: boolean }) {
  const reduced = useReducedMotion()
  const content = useRef<HTMLDivElement>(null)
  const [settled, setSettled] = useState(open)
  const [present, setPresent] = useState(open)
  useLayoutEffect(() => {
    if (content.current) {
      if (chatMotion && !open && content.current.contains(document.activeElement)) document.querySelector<HTMLButtonElement>(`[aria-controls="${id}"]`)?.focus()
      content.current.inert = !open
    }
    if (chatMotion && reduced) { setSettled(open); setPresent(open); return }
    setSettled(false)
    if (open) setPresent(true)
    const timer = setTimeout(() => { setSettled(open); setPresent(open) }, chatMotion ? 220 : 240)
    return () => clearTimeout(timer)
  }, [open, chatMotion, reduced, id])
  return (
    <div id={id} className="sidebar-disclosure" data-chat-motion={chatMotion} data-open={open} data-settled={settled} aria-hidden={!open}>
      <div ref={content} className="sidebar-disclosure-content">{!unmountOnExit || open || present ? children : null}</div>
    </div>
  )
}
