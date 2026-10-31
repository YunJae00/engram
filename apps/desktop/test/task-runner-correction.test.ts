import { expect, it } from 'vitest'
import { listTasks } from 'core'
import { done, setup } from './task-runner-fixture.js'

it('preserves the engine answer and reported limitations without another judge', async () => {
  const answer = 'Updated the report. The external source is unavailable.'
  const t = await setup(async () => ({ ...done(answer, 1), check: { accepted: false, issues: ['Source unavailable'] } }))
  await t.chat('Update the report')
  expect(t.sent).toHaveLength(1)
  expect((await listTasks(t.paths))[0]?.result).toBe(answer)
})
