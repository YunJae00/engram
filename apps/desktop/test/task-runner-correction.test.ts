import { expect, it } from 'vitest'
import { listTasks } from 'core'
import { done, setup } from './task-runner-fixture.js'

it('preserves the engine answer and reported limitations through one verification retry', async () => {
  const answer = 'Updated the report. The external source is unavailable.'
  const t = await setup(async () => ({ ...done(answer, 1), check: { accepted: false, issues: ['Source unavailable'] } }))
  await t.chat('Update the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]?.result).toBe(answer)
})

// qa142: every finished task was reported twice (the answer, then the re-check repeating it).
it('reports once when the re-check passes without changing anything', async () => {
  const report = 'Saved. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done(report, 1), check: { accepted: false, issues: ['Row count not read back'] } }
    : { ...done(`Checked again; all rows match. [Report](engram-artifact:report.md)`, 1), check: { accepted: true, issues: [] }, trail: [{ tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(2)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', verified: true })
  expect(t.delivered).toEqual([])
})
it('still reports what a re-check changed', async () => {
  const fixed = 'Fixed one row. [Report](engram-artifact:report.md)'
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Saved. [Report](engram-artifact:report.md)', 1), check: { accepted: false, issues: ['Row 3 differs'] } }
    : { ...done(fixed, 2), check: { accepted: true, issues: [] }, trail: [{ tool: 'file_create_copy', args: {}, observation: '{}' }, { tool: 'read_open_page', args: {}, observation: 'Read back' }] })
  await t.chat('Save the report')
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done' })
  expect(t.delivered).toEqual([fixed])
})
