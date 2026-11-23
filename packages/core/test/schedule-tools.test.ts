import { expect, it } from 'vitest'
import { scheduleTool, scheduleWordsKo, type ScheduleDeps } from '../src/schedule-tools.js'
import { takesCompanyLane } from '../src/company-tools.js'
import * as scheduleTools from '../src/schedule-tools.js'
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
  expect(await tool.run({ action: 'add', what: '지난주 팀이 한 일 요약하기', time: '09:00', days: [1] }, { task: '' })).toBe('매주 월요일 9시에 할게요: "지난주 팀이 한 일 요약하기"')
  expect(tasks[0]).toMatchObject({ goal: '지난주 팀이 한 일 요약하기', schedule: { days: [1], hour: 9, minute: 0 } })
  expect(typeof tool.closes === 'function' && [tool.closes({ action: 'add' }), tool.closes({ action: 'list' }), tool.closes({ action: 'remove' })]).toEqual([true, false, false])
  expect(JSON.parse(await tool.run({ action: 'list' }, { task: '' }) as string).scheduled[0]).toMatchObject({ what: '지난주 팀이 한 일 요약하기', when: '매주 월요일 9시' })
  expect(scheduleWordsKo({ days: [1, 2, 3, 4, 5], hour: 8, minute: 30 })).toBe('평일 8시 반')
  expect(scheduleWordsKo({ days: [0, 1, 2, 3, 4, 5, 6], hour: 0, minute: 0, every: 15 })).toBe('매일 밤 12시부터 15분마다')
  expect(scheduleWordsKo({ days: [], hour: 15, minute: 0, on: '2026-11-20' })).toBe('2026-11-20 오후 3시에 한 번')
  expect(kept().tool.closes).toBeUndefined()
})

it('a weekly or daily ask with a time takes the team lane however it is worded, and nothing in the host turns it into the schedule call', () => {
  const lead = { staff: ['하늘'], chief: true }
  for (const ask of ['매주 화요일 아침 7시에 도서관 신착 도서 알려줘', '매일 저녁 8시 반에 걸음 수 챙겨 줘', '평일마다 오전 10시에 셔틀 시간 알려주세요', '주말마다 낮 1시에 캠핑장 빈자리 봐 줘', '매주 목요일 22시에 가계부 정리해줘', '수요일마다 15시 정각에 하늘 작업 묶어 줘'])
    expect(takesCompanyLane(ask, lead), ask).toBe(true)
  for (const ask of ['매주 화요일 7시에 신착 도서 정리해서 슬랙에 올려줘', '모레 9시에 알려줘', '매주 하는 운동이 너무 힘들어'])
    expect(takesCompanyLane(ask, lead), ask).toBe(false)
  expect(takesCompanyLane('매일 저녁 8시 반에 걸음 수 챙겨 줘', { ...lead, scheduled: true })).toBe(false)
  expect(Object.keys(scheduleTools)).not.toContain('plainSchedule')
})

it('with a fake clock the real schedule tool lists what is kept and removes the id it listed, and nothing else removes one', async () => {
  const { tasks, tool } = kept(new Date(2026, 10, 18, 9, 0))
  await tool.run({ action: 'add', what: '셔틀 시간 알려줘', time: '07:40', days: [1, 2, 3, 4, 5] }, { task: '' })
  await tool.run({ action: 'add', what: '가계부 정리해줘', time: '22:00', days: [4] }, { task: '' })
  const listed = JSON.parse(await tool.run({ action: 'list' }, { task: '' }) as string).scheduled as { id: string; what: string }[]
  expect(listed.map(one => one.what)).toEqual(['셔틀 시간 알려줘', '가계부 정리해줘'])
  expect(tasks).toHaveLength(2)
  await tool.run({ action: 'remove', id: listed[1]!.id }, { task: '' })
  expect(tasks.map(task => task.goal)).toEqual(['셔틀 시간 알려줘'])
})

it('the confirmation is one sentence that promises the job at the time as people say it; an ending that cannot be turned is quoted', async () => {
  const tasks: BotTask[] = []
  const tool = scheduleTool({ list: async () => tasks, add: async (input) => { const task = { id: `t${tasks.length + 1}`, ...input }; tasks.push(task); return task }, remove: async () => true, duty: true, now: () => new Date(2026, 10, 16, 10, 0) })
  const add = (what: string, time: string, days: number[]) => tool.run({ action: 'add', what, time, days }, { task: '' })
  expect(await add('신착 도서 정리해줘', '09:00', [1])).toBe('매주 월요일 9시에 신착 도서 정리해 드릴게요.')
  expect(await add('가계부 정리해 줘', '15:30', [2])).toBe('매주 화요일 오후 3시 반에 가계부 정리해 드릴게요.')
  expect(await add('걸음 수 알려줘', '09:15', [0, 1, 2, 3, 4, 5, 6])).toBe('매일 9시 15분에 걸음 수 알려 드릴게요.')
  expect(await add('셔틀 시간 정리해주세요', '08:00', [1, 2, 3, 4, 5])).toBe('평일 8시에 셔틀 시간 정리해 드릴게요.')
  expect(await tool.run({ action: 'add', what: '주간 요약', time: '09:00', days: [1] }, { task: '' })).toBe('매주 월요일 9시에 할게요: "주간 요약"')
  expect(await tool.run({ action: 'add', what: '메일 확인해', time: '21:00', days: [1] }, { task: '' })).toBe('매주 월요일 오후 9시에 할게요: "메일 확인해"')
  expect(tasks[0]).toMatchObject({ goal: '신착 도서 정리해줘', schedule: { days: [1], hour: 9, minute: 0 } })
  expect(JSON.parse(await tool.run({ action: 'list' }, { task: '' }) as string).scheduled.map((one: { when: string }) => one.when).slice(0, 3)).toEqual(['매주 월요일 9시', '매주 화요일 오후 3시 반', '매일 9시 15분'])
  expect(JSON.parse(await tool.run({ action: 'remove', id: 't1' }, { task: '' }) as string)).toEqual({ removed: 't1' })
})
