import type { EngramEvent } from '../../../shared/types.js'

// The agent browser's picture, held outside any view. A person who leaves
// the thread for the cosmos and comes back is looking at the same work, so
// the last frame has to outlive the component that showed it.
//
// Frames are the expensive part - a hundred kilobytes each, several times a
// second - so they are asked for only while something is actually showing
// pixels. A view that shows the address alone knows what it needs from
// `ask`, and costs nothing.

export interface MirrorState {
  // A window is open and being mirrored.
  on: boolean
  url?: string
  frame: string | null
  width: number
  height: number
}

const EMPTY: MirrorState = { on: false, frame: null, width: 1280, height: 800 }

export function createAgentMirror(deps: { watch(on: boolean): void; ask(): Promise<{ on: boolean; url?: string }> }) {
  let state: MirrorState = EMPTY
  const listeners = new Set<() => void>()
  let showing = 0
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): MirrorState {
      return state
    },
    // Whether this view is showing the picture. The first to say so starts
    // the run of frames; the last to stop ends it.
    showPixels(on: boolean): void {
      showing = Math.max(0, showing + (on ? 1 : -1))
      if (on && showing === 1) deps.watch(true)
      if (!on && showing === 0) deps.watch(false)
    },
    // What is open right now, for a view that has just appeared.
    async ask(): Promise<void> {
      const now = await deps.ask().catch(() => null)
      if (!now) return
      state = { ...state, on: now.on, ...(now.url ? { url: now.url } : {}) }
      emit()
    },
    handleEvent(event: EngramEvent): void {
      if (event.type === 'agent:live') {
        // A window that went away leaves its last frame: the person can still
        // see where the work got to. A new one starts blank rather than
        // showing the page before it.
        state = event.on ? { ...state, on: true, url: event.url, frame: null } : { ...state, on: false }
        emit()
      } else if (event.type === 'agent:frame') {
        state = { on: true, url: event.url, frame: `data:image/jpeg;base64,${event.data}`, width: event.width, height: event.height }
        emit()
      }
    },
    forget(): void {
      state = EMPTY
      emit()
    },
  }
}

export type AgentMirror = ReturnType<typeof createAgentMirror>
