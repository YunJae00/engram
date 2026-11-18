import type { EngramEvent } from '../../../shared/types.js'

interface MirrorState {
  on: boolean
  lane: string
  url?: string
  frame: boolean
  width: number
  height: number
}

const EMPTY: MirrorState = { on: false, lane: '', frame: false, width: 1280, height: 800 }

export function createAgentMirror(deps: { watch(on: boolean): void; ask(): Promise<{ on: boolean; url?: string; lane?: string }> }) {
  let state: MirrorState = EMPTY
  let requestedLane: string | null = null
  let revision = 0
  let pixels: string | null = null
  const held = new Map<string, { data: string; width: number; height: number; url: string }>()
  const listeners = new Set<() => void>()
  const watchers = new Set<(data: string) => void>()
  let showing = 0
  const emit = (): void => {
    for (const listener of listeners) listener()
  }
  const set = (next: MirrorState): void => {
    if (next.on === state.on && next.lane === state.lane && next.url === state.url && next.frame === state.frame && next.width === state.width && next.height === state.height) return
    state = next
    emit()
  }
  return {
    select(lane: string): void {
      requestedLane = lane
      ++revision
      if (state.lane === lane) return
      const saved = held.get(lane)
      pixels = saved?.data ?? null
      set({ ...EMPTY, lane, frame: Boolean(saved), ...(saved ? { width: saved.width, height: saved.height, url: saved.url } : {}) })
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): MirrorState {
      return state
    },
    onFrame(watcher: (data: string) => void): () => void {
      watchers.add(watcher)
      if (pixels) watcher(pixels)
      return () => {
        watchers.delete(watcher)
      }
    },
    showPixels(on: boolean): void {
      showing = Math.max(0, showing + (on ? 1 : -1))
      if (on && showing === 1) deps.watch(true)
      if (!on && showing === 0) deps.watch(false)
    },
    async ask(): Promise<void> {
      const askedAt = revision
      const now = await deps.ask().catch(() => null)
      if (!now || askedAt !== revision || (requestedLane && now.lane !== requestedLane)) return
      set({ ...state, on: now.on, ...(now.url ? { url: now.url } : {}), ...(now.lane ? { lane: now.lane } : {}) })
    },
    handleEvent(event: EngramEvent): void {
      if (event.type === 'agent:live') {
        if (requestedLane && event.lane !== requestedLane) return
        ++revision
        const sameLane = Boolean(event.lane && event.lane === state.lane)
        if (event.on && !sameLane) pixels = null
        set(event.on ? { ...state, on: true, url: event.url, lane: event.lane ?? state.lane, frame: sameLane && state.frame } : { ...state, on: false })
      } else if (event.type === 'agent:frame') {
        held.set(event.lane, { data: event.data, width: event.width, height: event.height, url: event.url })
        if (held.size > 8) held.delete(held.keys().next().value!)
        if (requestedLane && event.lane !== requestedLane) return
        ++revision
        pixels = event.data
        for (const watcher of watchers) watcher(event.data)
        set({ on: true, url: event.url, lane: event.lane, frame: true, width: event.width, height: event.height })
      }
    },
    heldFor(lane: string): { data: string; width: number; height: number; url: string } | null {
      return held.get(lane) ?? null
    },
    clearLane(lane: string): void {
      held.delete(lane)
      if (state.lane !== lane) return
      ++revision
      pixels = null
      set({ ...EMPTY, lane })
    },
    forget(): void {
      requestedLane = null
      ++revision
      pixels = null
      state = EMPTY
      emit()
    },
  }
}

