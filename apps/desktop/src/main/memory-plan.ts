import { availableMemory } from './available-memory.js'

const GB = 1e9

let spokenFor = 0
export function reserveRoom(bytes: number): () => void {
  spokenFor += bytes
  let released = false
  return () => {
    if (released) return
    released = true
    spokenFor -= bytes
  }
}

export function roomNow(): number {
  return Math.max(0, availableMemory() - spokenFor)
}

export const EMBEDDER_FOOTPRINT = GB
export const EMBEDDER_MIN_FREE = GB
export const ROOM_FOR_EMBEDDER = EMBEDDER_FOOTPRINT + EMBEDDER_MIN_FREE
