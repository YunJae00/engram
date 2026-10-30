import { expect, it } from 'vitest'
import { runToolSession, type Engine, type EngineCwd } from 'core'
import { setup } from './task-runner-fixture.js'

it('parks partial collection barriers in waiting without a Continuing turn', async () => {
  const t = await setup(async () => {
    const engine = { id: 'mock', runTools: async job => {
      await job.tools.find(tool => tool.name === 'open_page')!.run({})
      const collect = job.tools.find(tool => tool.name === 'collect_results')!
      await collect.run({ items: ['First', 'Second'], fields: ['value'] })
      await collect.run({ item: 'First', values: { value: '42' }, evidenceStep: 1 })
      await collect.run({ status: 'blocked', summary: 'Please sign in for the second item.', evidenceStep: 1 })
      return { answer: 'Continuing' }
    } } as Engine
    const result = await runToolSession({ engine, workdir: t.paths.workspace as EngineCwd, tools: [{ name: 'open_page', description: '', argsSchema: {}, run: async () => 'First: 42; sign in for Second' }] }, 'Read both items')
    return { answer: result.answer, asked: result.asked === true, unfinished: !!result.incomplete, steps: result.steps.length, trail: result.steps }
  })
  await t.chat('Read both items')
  const task = await t.settle('waiting')
  expect(task.turns).toBe(1)
  expect(task.question).toBe('Please sign in for the second item.')
  expect(task.log.some(entry => entry.line === 'Continuing')).toBe(false)
  expect(t.sent).toHaveLength(1)
})
