import { useSyncExternalStore } from 'react'
import type { EngramEvent } from '../../../shared/types.js'

interface WebPaneState {
  folded: boolean
  wanted: boolean
  phase: 'idle' | 'working' | 'aside'
}
const EMPTY: WebPaneState = { folded: false, wanted: false, phase: 'idle' }
const lanes = new Map<string, WebPaneState>()
const listeners = new Set<() => void>()
function state(lane: string): WebPaneState { return lanes.get(lane) ?? EMPTY }
function set(lane: string, change: Partial<WebPaneState>): void {
  const before = state(lane)
  const next = { ...before, ...change }
  if (next.folded === before.folded && next.wanted === before.wanted && next.phase === before.phase) return
  lanes.set(lane, next)
  for (const listener of listeners) listener()
}

export const webPane = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: state,
  open(lane: string): void { set(lane, { folded: false, wanted: true }) },
  fold(lane: string): void { set(lane, { folded: true }) },
  // Tool names are the protocol, not the human-readable step summary.
  handleEvent(event: EngramEvent): boolean {
    if (!('channel' in event)) return false
    const lane = event.channel
    if (event.type === 'chat:done' || event.type === 'chat:error') set(lane, { phase: 'idle' })
    if (event.type !== 'comet:step') return false
    const tool = /^([a-z_]+):/.exec(event.line)?.[1] ?? ''
    if (/^(open_page|search_web|read_open_page|look|press|type_text|choose|scroll|hover|press_key|press_point|reveal|click_on|type_into)$/.test(tool)) {
      const entering = state(lane).phase === 'idle'
      set(lane, { phase: 'working', ...(entering ? { folded: false, wanted: true } : {}) })
      return entering
    }
    if (tool === 'aside' || tool === 'resume') {
      if (state(lane).phase !== 'idle') set(lane, { phase: tool === 'aside' ? 'aside' : 'working' })
    } else if (/^(excel_|ppt_|word_|outlook_|desktop_|read_desktop|look_desktop|read_live_document|edit_live_document|open_app)/.test(tool)) set(lane, { phase: 'idle' })
    return false
  },
}
export function useWebPane(lane: string): WebPaneState {
  return useSyncExternalStore(webPane.subscribe, () => state(lane))
}
