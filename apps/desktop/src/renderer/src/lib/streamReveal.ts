export const REVEAL_STEP_MS = 80
const SHARE = 6
const LEAST = 2

export function nextReveal(at: number, length: number, done: boolean): number {
  if (done) return length
  return Math.min(length, at + Math.max(LEAST, Math.ceil((length - at) / SHARE)))
}
