import { describe, expect, it } from 'vitest'
import { CONTEXT_BEGIN, CONTEXT_END, buildContextBlock, upsertContextBlock } from '../src/context-block.js'
import type { Note } from '../src/schema.js'

const NOW = new Date('2026-07-29T00:00:00Z')
let n = 0
function note(title: string, over: Partial<Note['front']> = {}): Note {
  n += 1
  return {
    front: {
      id: `n-${n}`,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      created: '2026-07-25T00:00:00.000Z',
      updated: '2026-07-25T00:00:00.000Z',
      ...over,
    },
    body: `# ${title}\n\nbody`,
  }
}

describe('what a session is handed', () => {
  const notes = [
    note('포팅 남은 것', { open_loop: true, created: '2026-07-22T00:00:00.000Z' }),
    note('보안 점검', { open_loop: true, due_at: '2026-08-01' }),
    note('국제화 제외 결정'),
    note('오래된 결정', { created: '2026-06-01T00:00:00.000Z', updated: '2026-06-01T00:00:00.000Z' }),
  ]
  const block = buildContextBlock(notes, NOW)

  it('carries what is open, with how long it has been open', () => {
    expect(block).toContain('포팅 남은 것')
    expect(block).toContain('open 7d')
  })

  it('carries a deadline when the note has one', () => {
    expect(block).toContain('due 2026-08-01')
  })

  it('carries what was settled recently, so a session does not contradict it', () => {
    expect(block).toContain('국제화 제외 결정')
  })

  it('leaves out what is too old to be the current situation', () => {
    expect(block).not.toContain('오래된 결정')
  })

  // It is injected ahead of the user's actual prompt, so bloat is a real cost.
  it('stays small enough to sit in front of every prompt', () => {
    expect(block.length).toBeLessThan(4_000)
  })

  it('says so plainly when there is nothing to say', () => {
    expect(buildContextBlock([], NOW)).toContain('Nothing recorded yet')
  })

  // The previous attempt at this inferred the user's projects statistically and
  // had to be deleted for fitting one vault. This one only projects.
  it('is a projection — every line comes from a note that exists', () => {
    const only = buildContextBlock([note('단 하나', { open_loop: true })], NOW)
    expect(only).toContain('단 하나')
    // no invented groupings, themes or project names
    expect(only.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1)
  })
})

describe('living inside a file the user owns', () => {
  const block = buildContextBlock([note('열린 일', { open_loop: true })], NOW)

  it('never disturbs what the user wrote around it', () => {
    const before = '# My rules\n\nAlways use tabs.\n'
    const merged = upsertContextBlock(before, block)
    expect(merged).toContain('Always use tabs.')
    expect(merged).toContain('열린 일')
  })

  it('replaces its own block instead of stacking copies', () => {
    const first = upsertContextBlock('# Mine\n', block)
    const second = upsertContextBlock(first, buildContextBlock([note('다른 일', { open_loop: true })], NOW))
    expect(second.split(CONTEXT_BEGIN)).toHaveLength(2)
    expect(second.split(CONTEXT_END)).toHaveLength(2)
    expect(second).toContain('다른 일')
    expect(second).not.toContain('열린 일')
    expect(second).toContain('# Mine')
  })

  it('works on a file that does not exist yet', () => {
    expect(upsertContextBlock('', block)).toContain(CONTEXT_BEGIN)
  })
})
