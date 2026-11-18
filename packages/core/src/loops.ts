import type { Note } from './schema.js'

const DAY = 86_400_000

const WEEK_DAYS = 7

const LOOP_URGENCIES = ['overdue', 'today', 'this-week', 'later', 'no-deadline'] as const

type LoopUrgency = (typeof LOOP_URGENCIES)[number]

const URGENCY_RANK: Record<LoopUrgency, number> = {
  overdue: 0,
  today: 1,
  'this-week': 2,
  later: 3,
  'no-deadline': 4,
}

function utcDay(ms: number): number {
  return Math.floor(ms / DAY)
}

export function daysUntilDue(note: Note, now: Date = new Date()): number | null {
  if (!note.front.due_at) return null
  return utcDay(Date.parse(note.front.due_at)) - utcDay(now.getTime())
}

export function daysOpen(note: Note, now: Date = new Date()): number {
  const born = Date.parse(note.front.created)
  if (Number.isNaN(born)) return 0
  return Math.max(0, utcDay(now.getTime()) - utcDay(born))
}

export function isOpenLoop(note: Note): boolean {
  return note.front.open_loop === true && note.front.status === 'current'
}

export function loopUrgency(note: Note, now: Date = new Date()): LoopUrgency {
  const days = daysUntilDue(note, now)
  if (days === null) return 'no-deadline'
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  return days <= WEEK_DAYS ? 'this-week' : 'later'
}

function dueKey(note: Note): number {
  return note.front.due_at ? Date.parse(note.front.due_at) : 0
}

export function openLoops(notes: Note[], now: Date = new Date()): Note[] {
  return notes.filter(isOpenLoop).sort((a, b) => {
    const byUrgency = URGENCY_RANK[loopUrgency(a, now)] - URGENCY_RANK[loopUrgency(b, now)]
    if (byUrgency !== 0) return byUrgency
    const byDue = dueKey(a) - dueKey(b)
    if (byDue !== 0) return byDue
    return Date.parse(a.front.created) - Date.parse(b.front.created)
  })
}

export function groupOpenLoops(notes: Note[], now: Date = new Date()): Record<LoopUrgency, Note[]> {
  const grouped = Object.fromEntries(LOOP_URGENCIES.map((u) => [u, [] as Note[]])) as Record<LoopUrgency, Note[]>
  for (const note of openLoops(notes, now)) grouped[loopUrgency(note, now)].push(note)
  return grouped
}
