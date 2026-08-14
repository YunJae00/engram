import { describe, expect, it } from 'vitest'
import { chronoKey, interpolateBetween, undeterminedNotes } from '../src/chronology.js'
import type { Note } from '../src/schema.js'
import { frontmatterSchema } from '../src/schema.js'

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

describe('chronology axis', () => {
  it('undetermined = inferred without happened_at (tray contents)', () => {
    const dated = makeNote('n-a-0003', { happened_at: '2026-03-01' })
    const tray = makeNote('n-b-0003')
    const ignored = makeNote('n-c-0003', { timeline: 'ignore' })
    expect(undeterminedNotes([dated, tray, ignored]).map((n) => n.front.id)).toEqual(['n-b-0003'])
  })

  it('chronoKey falls back to created when happened_at is absent', () => {
    const n = makeNote('n-a-0006', { created: '2026-04-01T00:00:00Z' })
    expect(chronoKey(n)).toBe(Date.parse('2026-04-01T00:00:00Z'))
  })
})

describe('interpolation (drag-and-pin)', () => {
  it('drop between two neighbours lands on the midpoint', () => {
    expect(interpolateBetween(1000, 3000)).toBe(2000)
  })

  it('drop at either edge offsets by one day', () => {
    const DAY = 86_400_000
    expect(interpolateBetween(5 * DAY, null)).toBe(6 * DAY)
    expect(interpolateBetween(null, 5 * DAY)).toBe(4 * DAY)
  })
})
