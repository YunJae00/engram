import { useEffect, useRef, useState, type ReactNode } from 'react'

export function SidebarDisclosure({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  const content = useRef<HTMLDivElement>(null)
  const [settled, setSettled] = useState(open)
  useEffect(() => {
    if (content.current) content.current.inert = !open
    setSettled(false)
    const timer = setTimeout(() => setSettled(open), 240)
    return () => clearTimeout(timer)
  }, [open])
  return (
    <div id={id} className="sidebar-disclosure" data-open={open} data-settled={settled} aria-hidden={!open}>
      <div ref={content} className="sidebar-disclosure-content">{children}</div>
    </div>
  )
}
