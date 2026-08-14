import { daysOpen, loopUrgency, openLoops } from './loops.js'
import { noteTitle } from './schema.js'
import type { Note } from './schema.js'

const ENTRY_CAP = 4
const DUE_CAP = 3
const COLD_DAYS = 14
const TITLE_MAX = 70

export interface StandupEntry {
  folder: string
  // The newest conclusion born in that folder, and how many days ago.
  last: string
  daysAgo: number
  open: number
}

export interface StandupDue {
  title: string
  overdue: boolean
}

export interface Standup {
  entries: StandupEntry[]
  // Loops due today or past due, overdue first — the "start here" answer.
  // Empty when nothing presses: the standup does not invent urgency.
  due: StandupDue[]
}

function trim(text: string): string {
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text
}

export interface ActiveFolder {
  folder: string
  notes: Note[]
  last: Note
}

// The folders with a conclusion in the last two weeks, newest-first. A cold
// folder is history, not a resume point.
export function activeFolders(notes: Note[], now: Date): ActiveFolder[] {
  const byFolder = new Map<string, Note[]>()
  for (const n of notes) {
    if (!n.front.context || n.front.status !== 'current') continue
    const list = byFolder.get(n.front.context) ?? []
    list.push(n)
    byFolder.set(n.front.context, list)
  }
  const rows: ActiveFolder[] = []
  for (const [folder, list] of byFolder) {
    const last = [...list].sort((a, b) => (a.front.created < b.front.created ? 1 : -1))[0]!
    if (daysOpen(last, now) > COLD_DAYS) continue
    rows.push({ folder, notes: list, last })
  }
  return rows.sort((a, b) => (a.last.front.created < b.last.front.created ? 1 : -1))
}

export function composeStandup(notes: Note[], now: Date = new Date()): Standup {
  const entries = activeFolders(notes, now)
    .slice(0, ENTRY_CAP)
    .map(({ folder, notes: list, last }) => ({
      folder,
      last: trim(noteTitle(last)),
      daysAgo: daysOpen(last, now),
      open: openLoops(list, now).length,
    }))
  // openLoops already sorts most-urgent-first, so the first DUE_CAP pressing
  // loops are the right ones and overdue naturally leads.
  const due = openLoops(notes, now)
    .map((n) => ({ n, urgency: loopUrgency(n, now) }))
    .filter(({ urgency }) => urgency === 'today' || urgency === 'overdue')
    .slice(0, DUE_CAP)
    .map(({ n, urgency }) => ({ title: trim(noteTitle(n)), overdue: urgency === 'overdue' }))
  return { entries, due }
}
