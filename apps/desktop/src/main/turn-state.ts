import type { StudyCheck } from './study-offers.js'

export const studying = new Set<string>()
export function unlessStudying<T, R>(channel: string, ask: (what: T) => Promise<R>): ((what: T) => Promise<R | 'cancel'>) & { reading: () => boolean } {
  return Object.assign((what: T) => studying.has(channel) ? Promise.resolve('cancel' as const) : ask(what), { reading: () => studying.has(channel) })
}

export const afterChecks = new Set<StudyCheck>()
export const answering = new Set<string>()
export const STEER_CAP = 4000
export const asides = new Map<string, { role: 'user' | 'assistant'; text: string }[]>()
export function takeAsides(channel: string): { role: 'user' | 'assistant'; text: string }[] {
  const said = asides.get(channel) ?? []
  asides.delete(channel)
  return said
}
export const turnGoals = new Map<string, string>()
export const offeredIn = new Set<string>()
export const workSoFar = new Map<string, string[]>()
