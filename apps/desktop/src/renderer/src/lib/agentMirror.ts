import type { EngramEvent } from '../../../shared/types.js'

// The agent browser's picture, held outside any view. A person who leaves
// the thread for the cosmos and comes back is looking at the same work, so
// the last frame has to outlive the component that showed it - and the
// stream has to be asked for once, by the window, rather than started and
// stopped by whatever happens to be mounted.

export interface MirrorState {
  // A window is open and being mirrored.
  on: boolean
  url?: string
  frame: string | null
  width: number
  height: number
}

const EMPTY: MirrorState = { on: false, frame: null, width: 1280, height: 800 }

export function createAgentMirror(watch: (on: boolean) => void) {
  let state: MirrorState = EMPTY
  const listeners = new Set<() => void>()
  let watching = 0
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      // The first view to look asks for the stream; the last to leave lets
      // it go. Moving between views does not interrupt it.
      if (++watching === 1) watch(true)
      return () => {
        listeners.delete(listener)
        if (--watching === 0) watch(false)
      }
    },
    getSnapshot(): MirrorState {
      return state
    },
    // What the main side says when a view first asks.
    open(on: boolean, url?: string): void {
      state = on ? { ...state, on, ...(url ? { url } : {}) } : { ...state, on }
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
