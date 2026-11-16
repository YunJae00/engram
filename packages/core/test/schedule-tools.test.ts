import { expect, it } from 'vitest'
import { plainSchedule, scheduleTool, scheduleWordsKo, type ScheduleDeps } from '../src/schedule-tools.js'
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

// grokbar C7 (stack2): one model round only to copy the day and the time into the call took 6.6 s of a 5 s bar, and the line read like a form.
it('a plain weekly or daily ask is the schedule call itself: day, time and the job in the person\'s words', () => {
  expect(plainSchedule('매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘')).toEqual({ action: 'add', what: '지난주 팀이 한 일 요약해줘', time: '09:00', days: [1] })
  expect(plainSchedule('매주 금요일 오후 3시 반에 이번 주 뉴스 정리해 줘')).toEqual({ action: 'add', what: '이번 주 뉴스 정리해 줘', time: '15:30', days: [5] })
  expect(plainSchedule('매일 9시 15분에 환율 알려줘')).toEqual({ action: 'add', what: '환율 알려줘', time: '09:15', days: [0, 1, 2, 3, 4, 5, 6] })
  expect(plainSchedule('평일마다 오전 8시에 오늘 일정 정리해주세요')).toEqual({ action: 'add', what: '오늘 일정 정리해주세요', time: '08:00', days: [1, 2, 3, 4, 5] })
  expect(plainSchedule('주말마다 낮 12시에 주간 요약 써줘')?.days).toEqual([0, 6])
  // The part of day settles the hour: 9시 in the evening is 21:00, midnight is 00:00.
  expect(plainSchedule('매주 수요일 저녁 9시에 회의록 요약해줘')?.time).toBe('21:00')
  expect(plainSchedule('매일 밤 12시에 하루 정리해줘')?.time).toBe('00:00')
  expect(plainSchedule('매일 오후 12시에 점심 메뉴 추천해줘')?.time).toBe('12:00')
  expect(plainSchedule('매일 18시에 뉴스 정리해줘')?.time).toBe('18:00')
  for (const ask of [
    '매주 월요일 3시에 뉴스 정리해줘', // 3 in the morning or the afternoon: the model's call
    '매주 월요일 아침 13시에 뉴스 정리해줘', '매일 25시에 뉴스 정리해줘', '매일 9시 70분에 뉴스 정리해줘',
    '매주 월요일이랑 목요일 9시에 뉴스 정리해줘', '매달 1일 9시에 정산해줘', '내일 9시에 알려줘', // other shapes
    '매주 월요일 9시에 요약해서 슬랙에 올려줘', '매주 월요일 9시에 지금 것도 정리하고 요약해줘', '매주 월요일 9시에 요약하고 금요일 5시에도 해줘', // outside, something now, a second time
    '매주 월요일 9시에 회의', '내 일정 뭐 있어?', '그거 취소해', // not a job to do; list and cancel stay the model's
  ]) expect(plainSchedule(ask), ask).toBeUndefined()
})

it('the confirmation is one sentence that promises the job at the time as people say it; an ending that cannot be turned is quoted', async () => {
  const tasks: BotTask[] = []
  const tool = scheduleTool({ list: async () => tasks, add: async (input) => { const task = { id: `t${tasks.length + 1}`, ...input }; tasks.push(task); return task }, remove: async () => true, duty: true, now: () => new Date(2026, 10, 16, 10, 0) })
  const add = (ask: string) => tool.run(plainSchedule(ask)!, { task: '' })
  expect(await add('매주 월요일 아침 9시에 지난주 팀이 한 일 요약해줘')).toBe('매주 월요일 9시에 지난주 팀이 한 일 요약해 드릴게요.')
  expect(await add('매주 금요일 오후 3시 반에 이번 주 뉴스 정리해 줘')).toBe('매주 금요일 오후 3시 반에 이번 주 뉴스 정리해 드릴게요.')
  expect(await add('매일 9시 15분에 환율 알려줘')).toBe('매일 9시 15분에 환율 알려 드릴게요.')
  expect(await add('평일마다 오전 8시에 오늘 일정 정리해주세요')).toBe('평일 8시에 오늘 일정 정리해 드릴게요.')
  expect(await tool.run({ action: 'add', what: '주간 요약', time: '09:00', days: [1] }, { task: '' })).toBe('매주 월요일 9시에 할게요: "주간 요약"')
  expect(await tool.run({ action: 'add', what: '메일 확인해', time: '21:00', days: [1] }, { task: '' })).toBe('매주 월요일 오후 9시에 할게요: "메일 확인해"')
  // What is kept runs later from the person's own words, and the list gives the time the same way.
  expect(tasks[0]).toMatchObject({ goal: '지난주 팀이 한 일 요약해줘', schedule: { days: [1], hour: 9, minute: 0 } })
  expect(JSON.parse(await tool.run({ action: 'list' }, { task: '' }) as string).scheduled.map((one: { when: string }) => one.when).slice(0, 3)).toEqual(['매주 월요일 9시', '매주 금요일 오후 3시 반', '매일 9시 15분'])
  expect(JSON.parse(await tool.run({ action: 'remove', id: 't1' }, { task: '' }) as string)).toEqual({ removed: 't1' })
})
