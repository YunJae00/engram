import type { Note } from './schema.js'

const DAY = 86_400_000

// "This week" is a rolling 7 days, not a calendar week: the brief is read every
// morning, so a Monday-anchored window would hide Friday's deadline until the
// week happened to roll over.
const WEEK_DAYS = 7

// Ordered most urgent first — consumers can iterate this to lay out sections.
export const LOOP_URGENCIES = ['overdue', 'today', 'this-week', 'later', 'no-deadline'] as const

export type LoopUrgency = (typeof LOOP_URGENCIES)[number]

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

// Whole days from now until the deadline: 0 = due today, negative = overdue,
// null = this loop has no deadline. Exported so callers stop re-deriving day
// math (and stop getting the date-only case wrong).
export function daysUntilDue(note: Note, now: Date = new Date()): number | null {
  if (!note.front.due_at) return null
  return utcDay(Date.parse(note.front.due_at)) - utcDay(now.getTime())
}

// Whole days since the note was written. An undated loop's row used to print
// "no deadline" under a group heading that already said No deadline — seven of
// them in a column said nothing seven times. Age is the honest answer to the
// question that column should be answering: why is this still here?
export function daysOpen(note: Note, now: Date = new Date()): number {
  const born = Date.parse(note.front.created)
  if (Number.isNaN(born)) return 0
  return Math.max(0, utcDay(now.getTime()) - utcDay(born))
}

// Only a current note can be an open loop: superseding one closes whatever it
// was asking for, a draft has not committed to anything yet, and a disputed
// note is already being adjudicated by a conflict card — surfacing it in the
// morning too would nag twice for one unanswered question. This predicate is
// the single authority — do not re-test `open_loop` on its own elsewhere.
export function isOpenLoop(note: Note): boolean {
  return note.front.open_loop === true && note.front.status === 'current'
}

// Classifies by deadline alone; filter with isOpenLoop first if that matters.
export function loopUrgency(note: Note, now: Date = new Date()): LoopUrgency {
  const days = daysUntilDue(note, now)
  if (days === null) return 'no-deadline'
  if (days < 0) return 'overdue'
  if (days === 0) return 'today'
  return days <= WEEK_DAYS ? 'this-week' : 'later'
}

// Undated loops all collapse to the same sort key and fall through to age below.
function dueKey(note: Note): number {
  return note.front.due_at ? Date.parse(note.front.due_at) : 0
}

// The open loops among these notes, most urgent first.
export function openLoops(notes: Note[], now: Date = new Date()): Note[] {
  return notes.filter(isOpenLoop).sort((a, b) => {
    const byUrgency = URGENCY_RANK[loopUrgency(a, now)] - URGENCY_RANK[loopUrgency(b, now)]
    if (byUrgency !== 0) return byUrgency
    const byDue = dueKey(a) - dueKey(b)
    if (byDue !== 0) return byDue
    // Within a bucket, oldest first: the intention captured three months ago is
    // the one actually rotting, and it is the only ordering undated loops get.
    return Date.parse(a.front.created) - Date.parse(b.front.created)
  })
}

// Same set as openLoops, split into buckets. Every bucket key always exists so
// callers can render a section without an emptiness dance.
export function groupOpenLoops(notes: Note[], now: Date = new Date()): Record<LoopUrgency, Note[]> {
  const grouped = Object.fromEntries(LOOP_URGENCIES.map((u) => [u, [] as Note[]])) as Record<LoopUrgency, Note[]>
  for (const note of openLoops(notes, now)) grouped[loopUrgency(note, now)].push(note)
  return grouped
}
