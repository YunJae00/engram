import { describe, expect, it } from 'vitest'
import { generateNoteId, NOTE_ID_PATTERN } from './id.js'

describe('generateNoteId', () => {
  it('matches the note id pattern', () => {
    expect(generateNoteId()).toMatch(NOTE_ID_PATTERN)
  })

  it('encodes the given timestamp so ids sort by creation time', () => {
    const earlier = generateNoteId(new Date('2026-01-01T00:00:00Z'))
    const later = generateNoteId(new Date('2026-06-01T00:00:00Z'))
    expect(earlier.split('-')[1]! < later.split('-')[1]!).toBe(true)
  })

  it('does not collide across many calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => generateNoteId()))
    expect(ids.size).toBe(1000)
  })
})
