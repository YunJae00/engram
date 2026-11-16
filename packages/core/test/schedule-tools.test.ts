import { expect, it } from 'vitest'
import { scheduleTool, scheduleWordsKo, type ScheduleDeps } from '../src/schedule-tools.js'
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

it('keeps a repeat every so many minutes and a listing to look at first, only from what the host can watch', async () => {
  const tasks: BotTask[] = []
  const tool = scheduleTool({ list: async () => tasks, add: async (input) => { const task = { id: 't1', ...input }; tasks.push(task); return task }, remove: async () => false, watchable: ['outlook_mail'] })
  expect(await tool.run({ action: 'add', what: 'Sort my new mail into to-dos', every: 15, onlyWhenNew: { tool: 'outlook_mail', args: { folder: 'inbox' } } }, { task: '' })).toContain('every day every 15 min from 00:00')
  expect(tasks[0]).toMatchObject({ schedule: { days: [0, 1, 2, 3, 4, 5, 6], hour: 0, minute: 0, every: 15 }, watch: { tool: 'outlook_mail', args: { folder: 'inbox' } } })
  await expect(tool.run({ action: 'add', what: 'x', every: 15, onlyWhenNew: { tool: 'file_read' } }, { task: '' })).rejects.toThrow('outlook_mail')
  await expect(tool.run({ action: 'add', what: 'x', every: 1 }, { task: '' })).rejects.toThrow('every')
  await expect(kept().tool.run({ action: 'add', what: 'x', every: 15, onlyWhenNew: { tool: 'outlook_mail' } }, { task: '' })).rejects.toThrow('Nothing can be watched')
})

it('on the person\'s own thread a kept schedule is confirmed by the tool in one Korean line that ends the turn; list and remove go on as before', async () => {
  const tasks: BotTask[] = []
  const tool = scheduleTool({ list: async () => tasks, add: async (input) => { const task = { id: 't1', ...input }; tasks.push(task); return task }, remove: async () => true, duty: true, now: () => new Date(2026, 10, 16, 10, 0) })
  expect(await tool.run({ action: 'add', what: '지난주 팀이 한 일 요약하기', time: '09:00', days: [1] }, { task: '' })).toBe('매주 월요일 09:00 일정으로 넣었어요: 지난주 팀이 한 일 요약하기')
  expect(tasks[0]).toMatchObject({ goal: '지난주 팀이 한 일 요약하기', schedule: { days: [1], hour: 9, minute: 0 } })
  expect(typeof tool.closes === 'function' && [tool.closes({ action: 'add' }), tool.closes({ action: 'list' }), tool.closes({ action: 'remove' })]).toEqual([true, false, false])
  expect(JSON.parse(await tool.run({ action: 'list' }, { task: '' }) as string).scheduled[0]).toMatchObject({ what: '지난주 팀이 한 일 요약하기', when: 'Mon 09:00' })
  expect(scheduleWordsKo({ days: [1, 2, 3, 4, 5], hour: 8, minute: 30 })).toBe('평일 08:30')
  expect(scheduleWordsKo({ days: [0, 1, 2, 3, 4, 5, 6], hour: 0, minute: 0, every: 15 })).toBe('매일 00:00부터 15분마다')
  expect(scheduleWordsKo({ days: [], hour: 15, minute: 0, on: '2026-11-20' })).toBe('2026-11-20 15:00에 한 번')
  expect(kept().tool.closes).toBeUndefined()
})
