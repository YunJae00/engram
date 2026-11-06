import { cloneElement, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { MOTION_MS, useReducedMotion } from '../lib/motion.js'
import './interaction-motion.css'

export function MotionSurface({ open, children, className, id, keepMounted = false }: { keepMounted?: boolean; open: boolean; children: ReactNode; className: string; id?: string }) {
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
  return open || present || keepMounted ? <div ref={ref} id={id} hidden={!open && !present} className={className} data-motion-state={open ? 'live' : 'exit'} aria-hidden={!open}>{children}</div> : null
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

const SURFACE = '.bots-view :is(.bots-thread, .comet-welcome):not([data-chat-snapshot])'
const STRIPPED = ['id', 'data-testid', 'autofocus', 'name', 'for', 'aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-owns', 'aria-activedescendant']
const liveSurface = () => [...document.querySelectorAll<HTMLElement>(SURFACE)].find(node => node.getClientRects().length)

function captureSurface(surface: HTMLElement) {
  const view = surface.closest<HTMLElement>('.bots-view')!
  const bounds = surface.getBoundingClientRect(), base = view.getBoundingClientRect(), style = getComputedStyle(surface)
  const scrolls = [surface, ...surface.querySelectorAll('*')].map(node => [node.scrollLeft, node.scrollTop] as const)
  const snapshot = surface.cloneNode(true) as HTMLElement
  for (const node of [snapshot, ...snapshot.querySelectorAll('*')]) for (const name of STRIPPED) node.removeAttribute(name)
  snapshot.inert = true
  snapshot.setAttribute('aria-hidden', 'true')
  snapshot.dataset.chatSnapshot = 'true'
  Object.assign(snapshot.style, { padding: style.padding, left: `${bounds.left - base.left - view.clientLeft}px`, top: `${bounds.top - base.top - view.clientTop}px`, width: `${bounds.width}px`, height: `${bounds.height}px` })
  return { snapshot, scrolls }
}

const idle = () => {}
// Scrolling never disposes a pair: the transcript auto-scrolls on mount and the snapshot is local to its containing block.
export function useChatNavigationMotion(activity: string) {
  const reduced = useReducedMotion()
  const dispose = useRef(idle)
  useEffect(() => {
    const cancel = () => dispose.current()
    window.addEventListener('resize', cancel)
    return () => { cancel(); window.removeEventListener('resize', cancel) }
  }, [activity, reduced])
  return (update: () => void) => {
    dispose.current()
    let outgoing: HTMLElement | undefined, captured: ReturnType<typeof captureSurface> | undefined
    try { outgoing = reduced ? undefined : liveSurface(); captured = outgoing && captureSurface(outgoing) } catch { captured = undefined }
    flushSync(update)
    const incoming = captured && liveSurface()
    if (!captured || !incoming || incoming === outgoing) return
    const { snapshot, scrolls } = captured, animations: Animation[] = []
    let timer = 0, live = true
    const done = () => {
      if (!live) return
      live = false
      window.clearTimeout(timer)
      for (const animation of animations) animation.cancel()
      snapshot.remove()
      if (dispose.current === done) dispose.current = idle
    }
    dispose.current = done
    try {
      incoming.closest('.bots-view')!.append(snapshot)
      ;[snapshot, ...snapshot.querySelectorAll('*')].forEach((node, index) => { const [left, top] = scrolls[index] ?? [0, 0]; if (left || top) node.scrollTo(left, top) })
      const options = { duration: MOTION_MS, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
      animations.push(snapshot.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(4px)' }], { ...options, fill: 'forwards', id: 'chat-session-exit' }))
      animations.push(incoming.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { ...options, id: 'chat-session-enter' }))
      // The keyed chat's own entrance would stack a second fade on the incoming thread.
      for (const legacy of incoming.closest('.bots-chat')?.getAnimations() ?? []) legacy.finish()
      void Promise.all(animations.map(animation => animation.finished)).then(done, done)
      timer = window.setTimeout(done, 250)
    } catch { done() }
  }
}
