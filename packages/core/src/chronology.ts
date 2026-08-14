import type { Note } from './schema.js'

export function chronoKey(note: Note): number {
  return Date.parse(note.front.happened_at ?? note.front.created)
}

export function undeterminedNotes(notes: Note[]): Note[] {
  return notes.filter((n) => n.front.timeline === 'inferred' && !n.front.happened_at)
}

// Drop between two neighbours → midpoint of their chrono keys (drag-and-pin).
export function interpolateBetween(prevMs: number | null, nextMs: number | null): number {
  const DAY = 86_400_000
  if (prevMs !== null && nextMs !== null) return Math.round((prevMs + nextMs) / 2)
  if (prevMs !== null) return prevMs + DAY
  if (nextMs !== null) return nextMs - DAY
  throw new Error('interpolateBetween needs at least one neighbour')
}
