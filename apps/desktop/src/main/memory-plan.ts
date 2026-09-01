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

// The embedder is the small one - a few hundred megabytes - and it is what
// tells one subject from another, so it is judged by its own weight and not
// by what a browser would need.
export const ROOM_FOR_EMBEDDER = 5 * GB
