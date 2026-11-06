import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { MOTION_MS, useReducedMotion } from '../lib/motion.js'
import './interaction-motion.css'

export function MotionSurface({ open, children, className, id }: { open: boolean; children: ReactNode; className: string; id?: string }) {
  const reduced = useReducedMotion()
  const [present, setPresent] = useState(open)
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (ref.current) {
      ref.current.inert = !open
      if (open && className === 'sidebar-folder-create') ref.current.querySelector('input')?.focus()
    }
    if (open || reduced) { setPresent(open); return }
    const timer = setTimeout(() => setPresent(false), MOTION_MS)
    return () => clearTimeout(timer)
  }, [open, reduced, className])
  return open || present ? <div ref={ref} id={id} className={className} data-motion-state={open ? 'live' : 'exit'} aria-hidden={!open}>{children}</div> : null
}

type Node = ReactElement<Record<string, unknown>>
type Exit = { node: Node; until: number }
export function MotionList({ children, liveKeys, disabled = false }: { children: Node[]; liveKeys?: string[]; disabled?: boolean }) {
  const reduced = useReducedMotion()
  const [state, setState] = useState({ children, exits: [] as Exit[] })
  if (state.children !== children) {
    const keys = new Set(children.map(node => node.key))
    const exits = [...state.exits, ...state.children.filter(node => !keys.has(node.key)).map(node => ({ node, until: Date.now() + MOTION_MS }))]
      .filter(({ node }) => !keys.has(node.key) && !liveKeys?.includes(String(node.key)))
    setState({ children, exits })
  }
  useLayoutEffect(() => {
    if (!state.exits.length) return
    if (reduced || disabled) { setState(current => ({ ...current, exits: [] })); return }
    const timer = setTimeout(() => setState(current => ({ ...current, exits: current.exits.filter(exit => exit.until > Date.now()) })), Math.max(0, Math.min(...state.exits.map(exit => exit.until)) - Date.now()))
    return () => clearTimeout(timer)
  }, [state.exits, reduced, disabled])
  return <>{[...children.map(node => ({ node, exiting: false })), ...(!reduced && !disabled ? state.exits.map(({ node }) => ({ node, exiting: true })) : [])].map(({ node, exiting }) => <MotionNode key={node.key} node={node} exiting={exiting} />)}</>
}
function MotionNode({ node, exiting = false }: { node: Node; exiting?: boolean }) {
  const ref = useRef<HTMLElement>(null)
  useLayoutEffect(() => { if (ref.current) ref.current.inert = exiting }, [exiting])
  const first = (node.props.children as ReactNode[])[0] as Node
  const snapshot = String(node.props.className).split(' ').includes('sidebar-folder') ? cloneElement(first, { children: (first.props.children as ReactNode[])[0] }) : first
  return cloneElement(node, { ref, 'data-motion-row': true, 'data-motion-state': exiting ? 'exit' : 'live', ...(exiting ? { 'aria-hidden': true, draggable: false, children: snapshot } : {}) })
}

export function ChatNavigationMotion() {
  const reduced = useReducedMotion()
  useEffect(() => {
    if (reduced || !document.startViewTransition) return
    let active: ViewTransition | undefined, replaying = false, disposed = false, generation = 0
    let updates = Promise.resolve()
    const click = (event: MouseEvent) => {
      if (replaying || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      const button = (event.target as Element).closest<HTMLButtonElement>('.app-sidebar button[data-testid]')
      const id = button?.dataset.testid
      if (!button || button.disabled || !document.querySelector('.bots-view') || !(id === 'bots-new' || id?.startsWith('bot-'))) return
      if (id === 'bots-new' ? !!document.querySelector('.comet-welcome') : button.classList.contains('active')) return
      event.preventDefault(); event.stopImmediatePropagation()
      const run = () => {
        if (disposed || !button.isConnected || !document.querySelector('.bots-view')) return
        let replayed = false
        const update = () => {
          if (replayed || disposed || !button.isConnected || !document.querySelector('.bots-view')) return
          replayed = true; replaying = true
          try { flushSync(() => button.click()) } finally { replaying = false }
        }
        const token = ++generation
        document.documentElement.dataset.chatMotion = 'true'
        try {
          active = document.startViewTransition(update)
          void active.ready.catch(() => undefined)
          void active.updateCallbackDone.catch(() => undefined)
          void active.finished.catch(() => undefined).finally(() => { if (token === generation) delete document.documentElement.dataset.chatMotion })
          return active.updateCallbackDone.catch(() => undefined)
        } catch { update(); delete document.documentElement.dataset.chatMotion }
      }
      active?.skipTransition()
      updates = updates.then(run)
    }
    document.addEventListener('click', click, true)
    return () => { disposed = true; active?.skipTransition(); delete document.documentElement.dataset.chatMotion; document.removeEventListener('click', click, true) }
  }, [reduced])
  return null
}
