import { expect, it } from 'vitest'
import { done, pressed, setup } from './task-runner-fixture.js'

it('delivers corrections without artifact links and summarizes unconfirmed checks', async () => {
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Original total 800', 1), trail: [pressed('Save')] }
    : { ...done('Corrected total 900', 1), trail: [pressed('Save corrected total')], check: { accepted: false, issues: ['The remote receipt could not be read.'] } }, false)
  await t.chat('Correct the total')
  const task = await t.settle('done')
  expect(task.result).toContain('Corrected total 900')
  expect(task.result).not.toContain('Original total 800')
  expect(task.result).toContain('The remote receipt could not be read.')
  expect(t.delivered).toEqual([task.result])
})
