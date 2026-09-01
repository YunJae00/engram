import type { EngramEvent } from '../../../shared/types.js'

// The agent browser's picture, held outside any view. A person who leaves
// the thread for the cosmos and comes back is looking at the same work, so
// the last frame has to outlive the component that showed it.
//
// Frames are the expensive part - a hundred kilobytes each, several times a
// second - so they are asked for only while something is actually showing
// pixels. A view that shows the address alone knows what it needs from
// `ask`, and costs nothing.
//
// Pixels travel on their own channel, never through the state a view renders
// from: a page mid-scroll would otherwise re-render the whole thread several
// times a second, which is what made a smooth page look like a slideshow.
// What views render from changes only when the window, its address or its
// shape does.

export interface MirrorState {
  // A window is open and being mirrored.
  on: boolean
  url?: string
  // Whether there is a picture to paint at all - the state a view needs to
  // decide between the screen and the waiting line.
  frame: boolean
  width: number
  height: number
}

const EMPTY: MirrorState = { on: false, frame: false, width: 1280, height: 800 }

export function createAgentMirror(deps: { watch(on: boolean): void; ask(): Promise<{ on: boolean; url?: string }> }) {
  let state: MirrorState = EMPTY
  // The newest picture, kept as it arrived: a canvas that has just appeared
  // paints this rather than waiting for the page to move.
  let pixels: string | null = null
  const listeners = new Set<() => void>()
  const watchers = new Set<(data: string) => void>()
  let showing = 0
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  const set = (next: MirrorState): void => {
    if (next.on === state.on && next.url === state.url && next.frame === state.frame && next.width === state.width && next.height === state.height) return
    state = next
    emit()
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
    // Every frame as it lands, for whatever is painting them. Returns the
    // picture in hand so a fresh canvas is never blank for a beat.
    onFrame(watcher: (data: string) => void): () => void {
      watchers.add(watcher)
      if (pixels) watcher(pixels)
      return () => {
        watchers.delete(watcher)
      }
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
      set({ ...state, on: now.on, ...(now.url ? { url: now.url } : {}) })
    },
    handleEvent(event: EngramEvent): void {
      if (event.type === 'agent:live') {
        // A window that went away leaves its last frame: the person can still
        // see where the work got to. A new one starts blank rather than
        // showing the page before it.
        if (event.on) pixels = null
        set(event.on ? { ...state, on: true, url: event.url, frame: false } : { ...state, on: false })
      } else if (event.type === 'agent:frame') {
        pixels = event.data
        for (const watcher of watchers) watcher(event.data)
        set({ on: true, url: event.url, frame: true, width: event.width, height: event.height })
      }
    },
    forget(): void {
      pixels = null
      state = EMPTY
      emit()
    },
  }
}

export type AgentMirror = ReturnType<typeof createAgentMirror>
