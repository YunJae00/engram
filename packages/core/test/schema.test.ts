import { describe, expect, it } from 'vitest'
import { frontmatterSchema, noteTitle, parseNote, serializeNote } from '../src/schema.js'

const SAMPLE = `---
id: n-abc123-0001
type: fact
status: current
supersedes: []
derived_from:
  - n-abc123-0000
decay: slow
verified_until: 2026-12-01T00:00:00.000Z
happened_at: 2026-05-01T00:00:00.000Z
timeline: inferred
created: 2026-06-01T10:00:00.000Z
updated: 2026-06-01T10:00:00.000Z
---
# 제목

본문이다.
`

describe('frontmatter schema', () => {
  it('parses a full note and keeps all fields', () => {
    const note = parseNote(SAMPLE)
    expect(note.front.id).toBe('n-abc123-0001')
    expect(note.front.derived_from).toEqual(['n-abc123-0000'])
    expect(Date.parse(note.front.happened_at!)).toBe(Date.parse('2026-05-01'))
    expect(note.body).toContain('본문이다.')
  })

  it('applies defaults for omitted fields', () => {
    const front = frontmatterSchema.parse({
      id: 'n-x-0001',
      created: '2026-01-01T00:00:00Z',
      updated: '2026-01-01T00:00:00Z',
    })
    expect(front.type).toBe('note')
    expect(front.status).toBe('current')
    expect(front.decay).toBe('slow')
    expect(front.timeline).toBe('inferred')
    expect(front.supersedes).toEqual([])
  })

  it('round-trips: parse → serialize → parse preserves meaning', () => {
    const first = parseNote(SAMPLE)
    const second = parseNote(serializeNote(first))
    expect(second.front.id).toBe(first.front.id)
    expect(Date.parse(second.front.verified_until!)).toBe(Date.parse(first.front.verified_until!))
    expect(second.front.derived_from).toEqual(first.front.derived_from)
    expect(second.body.trim()).toBe(first.body.trim())
  })

  it('serialization is stable after one cycle', () => {
    const once = serializeNote(parseNote(SAMPLE))
    const twice = serializeNote(parseNote(once))
    expect(twice).toBe(once)
  })

  it('rejects an invalid status', () => {
    expect(() =>
      frontmatterSchema.parse({
        id: 'n-x-0001',
        status: 'deleted',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      }),
    ).toThrow()
  })

  it('rejects a missing id', () => {
    expect(() =>
      frontmatterSchema.parse({ created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' }),
    ).toThrow()
  })

  it('rejects an invalid timeline mode', () => {
    expect(() =>
      frontmatterSchema.parse({
        id: 'n-x-0001',
        timeline: 'frozen',
        created: '2026-01-01T00:00:00Z',
        updated: '2026-01-01T00:00:00Z',
      }),
    ).toThrow()
  })

  it('derives the title from the first heading, falling back to id', () => {
    expect(noteTitle(parseNote(SAMPLE))).toBe('제목')
    const untitled = parseNote(
      '---\nid: n-x-0002\ncreated: 2026-01-01T00:00:00Z\nupdated: 2026-01-01T00:00:00Z\n---\n',
    )
    expect(noteTitle(untitled)).toBe('n-x-0002')
  })
})
