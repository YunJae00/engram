import os from 'node:os'

// What the machine can spare, honestly. Two heavyweights work here — the
// browser and the embedder — and starting one against a stale measurement is
// what actually tips a machine over: a browser was admitted at 9.6GB free and
// one heavy page took the machine to a standstill in seconds (measured). So
// room that somebody has already spoken for is planned around until it is
// handed back.
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
  return Math.max(0, os.freemem() - spokenFor)
}

// Cold admission includes its 1GB load budget. Once loaded, keep 1GB free
// for other work; using the cold threshold again would unload the model
// because of its own allocation, then load it again when that memory returns.
export const EMBEDDER_FOOTPRINT = GB
export const EMBEDDER_MIN_FREE = GB
export const ROOM_FOR_EMBEDDER = EMBEDDER_FOOTPRINT + EMBEDDER_MIN_FREE
