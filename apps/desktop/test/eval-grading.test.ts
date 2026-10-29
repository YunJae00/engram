import { expect, it } from 'vitest'
import { CASES } from '../scripts/eval-quick-cases.mts'

it('rejects plausible-looking but wrong project hours', () => {
  const grade = CASES.find(one => one.id === 'draft-from-records')!.grade
  const run = { answers: ['P-2205-01 | 999.0h\nP-2205-02 | 999.0h\nP-2205-03 | 999.0h'], site: { visits: ['GET /day/2026-01-01', 'GET /day/2026-01-02'], posts: [] }, offers: [], tasks: [] }
  expect(grade(run).hours).toBe(false)
  run.answers = ['P-2205-01 | 2.5h\nP-2205-02 | 1.0h\nP-2205-03 | 1.5h']
  expect(Object.values(grade(run)).every(Boolean)).toBe(true)
})
