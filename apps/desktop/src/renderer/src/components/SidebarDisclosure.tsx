import { useEffect, useRef, useState, type ReactNode } from 'react'

export function SidebarDisclosure({ id, open, children, unmountOnExit = false }: { id: string; open: boolean; children: ReactNode; unmountOnExit?: boolean }) {
  const content = useRef<HTMLDivElement>(null)
  const [settled, setSettled] = useState(open)
  const [present, setPresent] = useState(open)
  useEffect(() => {
    if (content.current) content.current.inert = !open
    setSettled(false)
    if (open) setPresent(true)
    const timer = setTimeout(() => { setSettled(open); setPresent(open) }, 240)
    return () => clearTimeout(timer)
  }, [open])
  return (
    <div id={id} className="sidebar-disclosure" data-open={open} data-settled={settled} aria-hidden={!open}>
      <div ref={content} className="sidebar-disclosure-content">{!unmountOnExit || open || present ? children : null}</div>
    </div>
  )
}
