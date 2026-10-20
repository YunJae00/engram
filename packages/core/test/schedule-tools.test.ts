import { expect, it } from 'vitest'
import { scheduleTool, type ScheduleDeps } from '../src/schedule-tools.js'
import type { BotTask } from '../src/bots.js'

function kept(now = new Date(2026, 9, 19, 10, 0)) {
  const tasks: BotTask[] = []
  const deps: ScheduleDeps = {
    list: async () => tasks,
    add: async (input) => { const task = { id: `t${tasks.length + 1}`, ...input }; tasks.push(task); return task },
    remove: async (id) => { const at = tasks.findIndex((task) => task.id === id); if (at < 0) return false; tasks.splice(at, 1); return true },
    now: () => now,
  }
  return { tasks, tool: scheduleTool(deps) }
}

it('keeps a repeat and a one-day request, lists them in words, and removes one by id', async () => {
  const { tasks, tool } = kept()
  expect(await tool.run({ action: 'add', what: 'Sum up my mail', time: '9:00', days: [1, 2, 3, 4, 5] }, { task: '' })).toContain('weekdays 09:00')
  expect(await tool.run({ action: 'add', what: 'Remind me to call', time: '15:30', date: '2026-10-20' }, { task: '' })).toContain('2026-10-20 15:30, once')
  expect(tasks.map((task) => task.schedule)).toEqual([{ days: [1, 2, 3, 4, 5], hour: 9, minute: 0 }, { days: [], hour: 15, minute: 30, on: '2026-10-20' }])
  expect(JSON.parse(await tool.run({ action: 'list' }, { task: '' }) as string).scheduled).toHaveLength(2)
  await tool.run({ action: 'remove', id: 't1' }, { task: '' })
  expect(tasks.map((task) => task.goal)).toEqual(['Remind me to call'])
})

it('refuses what cannot run: no time, no day, a moment already gone, an id that is not kept', async () => {
  const { tool } = kept()
  await expect(tool.run({ action: 'add', what: 'x', time: '25:00', days: [1] }, { task: '' })).rejects.toThrow('HH:MM')
  await expect(tool.run({ action: 'add', what: 'x', time: '09:00' }, { task: '' })).rejects.toThrow('days')
  await expect(tool.run({ action: 'add', what: 'x', time: '09:00', date: '2026-10-19' }, { task: '' })).rejects.toThrow('passed')
  await expect(tool.run({ action: 'remove', id: 'nope' }, { task: '' })).rejects.toThrow('list')
})
