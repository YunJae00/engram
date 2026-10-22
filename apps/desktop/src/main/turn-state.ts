import type { StudyCheck } from './study-offers.js'

// What each conversation's running turn holds besides the turn itself: the
// words said to it, what it was asked and has done, and the checks after it.

// While a comet studies nothing is changed: every press that would commit is refused.
export const studying = new Set<string>()
export function unlessStudying<T, R>(channel: string, ask: (what: T) => Promise<R>): (what: T) => Promise<R | 'cancel'> {
  return (what) => studying.has(channel) ? Promise.resolve('cancel') : ask(what)
}

export const afterChecks = new Set<StudyCheck>()
// Channels whose answer has not been delivered yet. A turn keeps working
// after that - what to remember from it, what to offer - and that work is
// still cancellable, but it is not something to wait on.
export const answering = new Set<string>()
// What the person wrote while a turn was working, waiting for that turn's next tool result.
export const steers = new Map<string, string[]>()
// Words a turn took in, kept so the thread records them where they were said.
export const heard = new Map<string, string[]>()
export const STEER_CAP = 4000
// What was said with the voice while a turn worked, both sides, written into
// the transcript after the ask and before the answer, where it happened.
export const asides = new Map<string, { role: 'user' | 'assistant'; text: string }[]>()
export function takeAsides(channel: string): { role: 'user' | 'assistant'; text: string }[] {
  const said = asides.get(channel) ?? []
  asides.delete(channel)
  return said
}
// Instructions the voice passed on, taken in at the turn's next step.
export const relayed = new Map<string, string[]>()
// What each running turn was asked, and what it has done so far.
export const turnGoals = new Map<string, string>()
// Turns that already offered another way; the after-check leaves them be.
export const offeredIn = new Set<string>()
// Words handed to a running turn, checked against its answer when it ends.
export const handedOver = new Map<string, string[]>()
export const workSoFar = new Map<string, string[]>()

export function takeHeard(channel: string): string[] {
  const said = heard.get(channel) ?? []
  heard.delete(channel)
  return said
}
