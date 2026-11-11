import { describe, expect, it } from 'vitest'
import { DUE_WINDOW_MS as CORE_WINDOW, EVERY_MAX as CORE_MAX, EVERY_MIN as CORE_MIN, isSchedule } from 'core/src/schedule'
import { DUE_WINDOW_MS, EVERY_MAX, EVERY_MIN, nextRun, routineRows, runHistory, validSchedule } from '../src/renderer/src/lib/botRoutines.js'

const daily = { days: [0, 1, 2, 3, 4, 5, 6], hour: 9, minute: 0 }
const iso = (...args: [number, number, number, number, number]) => new Date(...args).toISOString()

describe('bot routines tab derivation', () => {
  it('next run time, last 20 outcomes, paused shown', () => {
    const now = new Date(2026, 0, 7, 10, 0)
    expect(nextRun(daily, iso(2026, 0, 7, 9, 5), now)).toEqual(new Date(2026, 0, 8, 9, 0))
    expect(nextRun(daily, iso(2026, 0, 6, 9, 5), new Date(2026, 0, 7, 8, 0))).toEqual(new Date(2026, 0, 7, 9, 0))
    expect(nextRun(daily, undefined, now)).toEqual(new Date(2026, 0, 7, 9, 0))
    expect(nextRun({ ...daily, days: [1] }, undefined, now)).toEqual(new Date(2026, 0, 12, 9, 0))
    expect(nextRun({ ...daily, days: [] }, undefined, now)).toBeNull()
    expect(nextRun({ ...daily, on: '2026-01-06' }, undefined, now)).toBeNull()
    expect(nextRun({ ...daily, on: '2026-01-09' }, undefined, now)).toEqual(new Date(2026, 0, 9, 9, 0))
    expect(nextRun({ ...daily, on: '2026-01-09' }, iso(2026, 0, 9, 9, 0), now)).toBeNull()
    expect(nextRun({ ...daily, every: 60 }, iso(2026, 0, 7, 10, 0), new Date(2026, 0, 7, 10, 30))).toEqual(new Date(2026, 0, 7, 11, 0))
    expect(nextRun({ ...daily, every: 60 }, iso(2026, 0, 7, 23, 30), new Date(2026, 0, 7, 23, 40))).toEqual(new Date(2026, 0, 8, 9, 0))

    const rows = routineRows([
      { id: 'a', name: 'Daily', goal: 'g', schedule: daily, lastRunAt: iso(2026, 0, 7, 9, 5), routineId: 'r-1' },
      { id: 'p', name: 'Paused', goal: 'g', schedule: daily, paused: true, routineId: '' },
      { id: 'n', name: 'Unscheduled', goal: 'g' },
      { id: 'x', name: 'Bad every', goal: 'g', schedule: { ...daily, every: 3 }, paused: 'yes' },
      { name: 'No id', goal: 'g' }, { id: '', name: 'Empty id' }, { id: 'y', name: 7 }, null, 'junk',
    ], now)
    expect(rows).toEqual([
      { id: 'a', name: 'Daily', paused: false, routineId: 'r-1', next: new Date(2026, 0, 8, 9, 0) },
      { id: 'p', name: 'Paused', paused: true, routineId: null, next: null },
      { id: 'n', name: 'Unscheduled', paused: false, routineId: null, next: null },
      { id: 'x', name: 'Bad every', paused: false, routineId: null, next: null },
    ])
    expect(routineRows({ length: 1, 0: { id: 'a', name: 'b' } }, now)).toEqual([])

    const states = ['queued', 'running', 'waiting', 'done', 'failed']
    const own = Array.from({ length: 25 }, (_, i) => ({ id: `t${i}`, botId: 'bot', state: states[i % 5], createdAt: iso(2026, 0, 1, 0, i) }))
    const runs = runHistory([
      ...own,
      { id: 'foreign', botId: 'other', state: 'done', createdAt: iso(2026, 0, 2, 0, 0) },
      { id: 'stopped', botId: 'bot', state: 'stopped', createdAt: iso(2026, 0, 2, 0, 0) },
      { id: 'odd', botId: 'bot', state: 'weird', createdAt: iso(2026, 0, 2, 0, 0) },
      { id: 'bad', botId: 'bot', state: 'done', createdAt: 'not a date' },
      { id: 3, botId: 'bot', state: 'done', createdAt: iso(2026, 0, 2, 0, 0) },
    ], 'bot')
    expect(runs).toHaveLength(20)
    expect(runs.map(r => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => `t${24 - i}`))
    const want = { queued: 'running', running: 'running', waiting: 'running', done: 'succeeded', failed: 'failed' } as Record<string, string>
    for (const run of runs) expect(run.state).toBe(want[states[Number(run.id.slice(1)) % 5]!])
    expect(runs[0]!.at).toBe(iso(2026, 0, 1, 0, 24))
    expect(runHistory('junk', 'bot')).toEqual([])
  })

  it('schedule check and constants match core', () => {
    expect([EVERY_MIN, EVERY_MAX, DUE_WINDOW_MS]).toEqual([CORE_MIN, CORE_MAX, CORE_WINDOW])
    const table: unknown[] = [
      daily, { days: [], hour: 0, minute: 0 }, { days: [1, 5], hour: 23, minute: 59 }, { days: [7], hour: 9, minute: 0 },
      { days: [1.5], hour: 9, minute: 0 }, { days: '1', hour: 9, minute: 0 }, { hour: 9, minute: 0 }, { days: [1], hour: 24, minute: 0 },
      { days: [1], hour: 9, minute: 60 }, { days: [1], hour: -1, minute: 0 }, { days: [1], hour: '9', minute: 0 },
      { ...daily, every: 5 }, { ...daily, every: 1440 }, { ...daily, every: 4 }, { ...daily, every: 1441 }, { ...daily, every: 7.5 },
      { ...daily, on: '2026-02-28' }, { ...daily, on: '2026-02-30' }, { ...daily, on: '2026-2-28' }, { ...daily, on: 20260228 },
      { ...daily, on: '2026-02-28', every: 60 }, { ...daily, on: '2024-02-29' }, { ...daily, on: '2026-13-01' },
      null, undefined, 'daily', 9, [],
    ]
    for (const value of table) expect([value, validSchedule(value)]).toEqual([value, isSchedule(value)])
  })
})
