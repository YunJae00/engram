import type { EngramEvent } from '../../../shared/types.js'

// What the one local model is doing, as main and the worker say it: warming,
// reading a prompt, writing. Kept outside the view: the tab that shows it
// unmounts on every switch, and a wait that lost its words on a switch would
// read as a hang. 'loading' is only ever learned from a live broadcast - a
// missed one degrades to the plain line, never to a claim.
export type ModelWarm = Extract<EngramEvent, { type: 'localllm:warm' }>['state']

export interface ModelProgress {
  phase: 'reading' | 'writing'
  kind: 'choice' | 'prose'
  done: number
  total?: number
  words?: number
}

export interface ModelActivity {
  warm: ModelWarm
  progress: ModelProgress | null
}

export type ModelActivityStore = ReturnType<typeof createModelActivity>

export function createModelActivity() {
  let snapshot: ModelActivity = { warm: 'cold', progress: null }
  const listeners = new Set<() => void>()
  const set = (next: ModelActivity): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: (): ModelActivity => snapshot,
    handleEvent(event: EngramEvent): void {
      if (event.type === 'localllm:warm') {
        set({ ...snapshot, warm: event.state })
        return
      }
      if (event.type !== 'localllm:progress') return
      const { phase, kind, done, total, words } = event
      set({
        ...snapshot,
        progress:
          phase === 'done'
            ? null
            : { phase, kind, done, ...(total !== undefined ? { total } : {}), ...(words !== undefined ? { words } : {}) },
      })
    },
  }
}
