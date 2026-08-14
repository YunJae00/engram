import { describe, expect, it } from 'vitest'
import { composeStandup } from '../src/standup.js'
import type { Note } from '../src/schema.js'

const NOW = new Date('2026-08-05T09:00:00Z')
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
      created: '2026-08-03T00:00:00.000Z',
      updated: '2026-08-03T00:00:00.000Z',
      ...over,
    },
    body: `# ${title}\n\nbody`,
  }
}

describe('composeStandup', () => {
  it('tells each active folder where it left off, newest folder first', () => {
    const standup = composeStandup(
      [
        note('릴리즈 파이프라인 복구', { context: 'strata', created: '2026-08-04T00:00:00.000Z' }),
        note('lastSyncAt 게이팅', { context: 'ai', created: '2026-08-02T00:00:00.000Z' }),
        note('ai 폴더 열린 일', { context: 'ai', open_loop: true, created: '2026-08-01T00:00:00.000Z' }),
      ],
      NOW,
    )
    expect(standup.entries.map((e) => e.folder)).toEqual(['strata', 'ai'])
    expect(standup.entries[0]).toMatchObject({ last: '릴리즈 파이프라인 복구', daysAgo: 1, open: 0 })
    expect(standup.entries[1]).toMatchObject({ open: 1 })
  })

  it('a folder cold for two weeks is history, and folderless notes are not a folder', () => {
    const standup = composeStandup(
      [
        note('식은 프로젝트', { context: 'old', created: '2026-07-01T00:00:00.000Z' }),
        note('폴더 없는 결론', {}),
      ],
      NOW,
    )
    expect(standup.entries).toEqual([])
  })

  it('names what presses today, overdue first, and stays silent when nothing does', () => {
    const pressing = composeStandup(
      [
        note('오늘 마감', { open_loop: true, due_at: '2026-08-05' }),
        note('지난 마감', { open_loop: true, due_at: '2026-08-01' }),
        note('다음 주', { open_loop: true, due_at: '2026-08-20' }),
      ],
      NOW,
    )
    expect(pressing.due).toEqual([
      { title: '지난 마감', overdue: true },
      { title: '오늘 마감', overdue: false },
    ])
    expect(composeStandup([note('마감 없는 일', { open_loop: true })], NOW).due).toEqual([])
  })

  it('caps folders at 4 and pressing loops at 3 — a card, not a report', () => {
    const notes = [
      ...Array.from({ length: 6 }, (_, i) =>
        note(`폴더${i} 결론`, { context: `f${i}`, created: `2026-08-0${i > 3 ? 4 : i + 1}T00:00:00.000Z` }),
      ),
      ...Array.from({ length: 5 }, (_, i) => note(`마감${i}`, { open_loop: true, due_at: '2026-08-04' })),
    ]
    const standup = composeStandup(notes, NOW)
    expect(standup.entries.length).toBe(4)
    expect(standup.due.length).toBe(3)
  })
})
