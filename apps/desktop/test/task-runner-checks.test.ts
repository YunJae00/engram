import { expect, it } from 'vitest'
import { listTasks, TASK_TOKEN_BUDGET } from 'core'
import { done, setup, pressed } from './task-runner-fixture.js'

it.each(['Saved', '[Report](engram-artifact:report.md)'])('delivers %s without a separate verification turn', async answer => {
  const t = await setup(async () => ({ ...done(answer, 1), trail: [pressed('Save')] }))
  await t.chat('Save the report')
  expect(t.sent).toHaveLength(1)
  expect(t.sent[0]?.extra?.verification).toBeUndefined()
  expect(t.delivered).toEqual([])
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'done', result: answer, turns: 1 })
})

it('allows turn thirteen while token budget remains', async () => {
  const { createTask, updateTask } = await import('core')
  const t = await setup(async () => done('Finished'))
  const task = await createTask(t.paths, 'Long job', 'bot-1')
  await updateTask(t.paths, task.id, saved => { saved.state = 'waiting'; saved.question = 'Which source?'; saved.turns = 12 })
  await t.chat('Use the supplied source')
  expect((await listTasks(t.paths))[0]).toMatchObject({ turns: 13, state: 'done' })
})

it('persists reported token usage and does not restart an exhausted task', async () => {
  const t = await setup(async () => ({ ...done('Token budget reached'), tokensUsed: TASK_TOKEN_BUDGET, budgetExhausted: true }))
  await t.chat('Long job')
  expect(t.sent).toHaveLength(1)
  expect((await listTasks(t.paths))[0]).toMatchObject({ state: 'failed', tokensUsed: TASK_TOKEN_BUDGET })
})

it('continues paused work only on user input and never learns it as a question answer', async () => {
  const t = await setup(async (_request, turn) => turn === 1 ? { ...done('The source is unavailable'), unfinished: true } : done('Finished'))
  await t.chat('Read the report')
  expect(t.sent).toHaveLength(1)
  await t.chat('Use the attached copy')
  expect(await listTasks(t.paths)).toHaveLength(1)
  expect(t.sent).toHaveLength(2)
  expect(t.learned).toEqual([])
  expect(t.sent[1]?.extra?.context).toContain('Original task: Read the report')
})
