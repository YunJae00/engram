import { describe, expect, it } from 'vitest'
import { daysUntilDue, groupOpenLoops, isOpenLoop, loopUrgency, openLoops } from '../src/loops.js'
import type { Note } from '../src/schema.js'
import { frontmatterSchema } from '../src/schema.js'

const NOW = new Date('2026-07-26T09:00:00Z')

function makeNote(id: string, over: Record<string, unknown> = {}): Note {
  return {
    front: frontmatterSchema.parse({
      id,
      created: '2026-06-01T00:00:00Z',
      updated: '2026-06-01T00:00:00Z',
      ...over,
    }),
    body: `# ${id}`,
  }
}

const overdue = makeNote('n-overdue', { open_loop: true, due_at: '2026-07-20' })
const today = makeNote('n-today', { open_loop: true, due_at: '2026-07-26' })
const thisWeek = makeNote('n-week', { open_loop: true, due_at: '2026-07-30' })
const later = makeNote('n-later', { open_loop: true, due_at: '2026-08-20' })
const undated = makeNote('n-undated', { open_loop: true })

describe('open loops (does this memory still want something from me?)', () => {
  it('classifies by deadline: overdue / today / this week / later / no deadline', () => {
    expect(loopUrgency(overdue, NOW)).toBe('overdue')
    expect(loopUrgency(today, NOW)).toBe('today')
    expect(loopUrgency(thisWeek, NOW)).toBe('this-week')
    expect(loopUrgency(later, NOW)).toBe('later')
    expect(loopUrgency(undated, NOW)).toBe('no-deadline')
  })

  it('a date-only deadline lasts the whole day, and is overdue the next day', () => {
    // due_at lands on UTC midnight; NOW is already 09:00 on that day.
    expect(loopUrgency(today, NOW)).toBe('today')
    expect(loopUrgency(today, new Date('2026-07-26T23:59:00Z'))).toBe('today')
    expect(loopUrgency(today, new Date('2026-07-27T00:01:00Z'))).toBe('overdue')
  })

  it('the week window is a rolling 7 days, inclusive of the 7th', () => {
    expect(loopUrgency(makeNote('n-d7', { open_loop: true, due_at: '2026-08-02' }), NOW)).toBe('this-week')
    expect(loopUrgency(makeNote('n-d8', { open_loop: true, due_at: '2026-08-03' }), NOW)).toBe('later')
  })

  it('counts days to the deadline, negative once it has passed', () => {
    expect(daysUntilDue(overdue, NOW)).toBe(-6)
    expect(daysUntilDue(today, NOW)).toBe(0)
    expect(daysUntilDue(thisWeek, NOW)).toBe(4)
    expect(daysUntilDue(undated, NOW)).toBeNull()
  })

  it('orders loops most urgent first', () => {
    const shuffled = [undated, later, today, thisWeek, overdue]
    expect(openLoops(shuffled, NOW).map((n) => n.front.id)).toEqual([
      'n-overdue',
      'n-today',
      'n-week',
      'n-later',
      'n-undated',
    ])
  })

  it('breaks ties inside a bucket by deadline, then by age', () => {
    const soon = makeNote('n-soon', { open_loop: true, due_at: '2026-07-28' })
    const late = makeNote('n-late', { open_loop: true, due_at: '2026-08-01' })
    const old = makeNote('n-old', { open_loop: true, created: '2026-01-01T00:00:00Z' })
    const fresh = makeNote('n-fresh', { open_loop: true, created: '2026-07-25T00:00:00Z' })
    expect(openLoops([late, fresh, soon, old], NOW).map((n) => n.front.id)).toEqual([
      'n-soon',
      'n-late',
      'n-old',
      'n-fresh',
    ])
  })

  it('never counts a note without the fields — the 108 notes already in a vault', () => {
    const plain = makeNote('n-plain')
    const dated = makeNote('n-dated', { due_at: '2026-07-20' })
    const closed = makeNote('n-closed', { open_loop: false, due_at: '2026-07-20' })
    expect(isOpenLoop(plain)).toBe(false)
    expect(isOpenLoop(dated)).toBe(false)
    expect(isOpenLoop(closed)).toBe(false)
    expect(openLoops([plain, dated, closed], NOW)).toEqual([])
  })

  it('excludes non-current notes — superseding a note closes its loop', () => {
    const gone = makeNote('n-gone', { open_loop: true, status: 'superseded', due_at: '2026-07-20' })
    const draft = makeNote('n-draft', { open_loop: true, status: 'draft' })
    const disputed = makeNote('n-disputed', { open_loop: true, status: 'disputed' })
    expect(isOpenLoop(gone)).toBe(false)
    expect(openLoops([gone, draft, disputed, today], NOW).map((n) => n.front.id)).toEqual(['n-today'])
  })

  it('groups into every bucket, empty ones included', () => {
    const grouped = groupOpenLoops([undated, overdue, today], NOW)
    expect(grouped.overdue.map((n) => n.front.id)).toEqual(['n-overdue'])
    expect(grouped.today.map((n) => n.front.id)).toEqual(['n-today'])
    expect(grouped['this-week']).toEqual([])
    expect(grouped.later).toEqual([])
    expect(grouped['no-deadline'].map((n) => n.front.id)).toEqual(['n-undated'])
  })

  it('survives a frontmatter round-trip', () => {
    const parsed = frontmatterSchema.parse({
      id: 'n-rt',
      created: '2026-06-01T00:00:00Z',
      updated: '2026-06-01T00:00:00Z',
      open_loop: true,
      due_at: '2026-07-30',
    })
    expect(parsed.open_loop).toBe(true)
    expect(Date.parse(parsed.due_at!)).toBe(Date.parse('2026-07-30'))
  })
})
