import type { AgentTool } from './agent-loop.js'
import type { BotTask } from './bots.js'
import { isSchedule, localDay, type Schedule } from './schedule.js'

// What a person asks to have done later - "every weekday at 9, sum up my
// mail" or "tomorrow at 3, remind me to call" - kept on this conversation.
// At its time the words are said here again as a new message and run as a
// turn like any other, and the person is notified when it is done.
export interface ScheduleDeps {
  list(): Promise<BotTask[]>
  add(input: { name: string; goal: string; schedule: Schedule }): Promise<BotTask>
  remove(id: string): Promise<boolean>
  now?(): Date
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function scheduleWords(schedule: Schedule): string {
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
  if (schedule.on) return `${schedule.on} ${time}, once`
  const days = [...schedule.days].sort((a, b) => a - b)
  const when = days.length === 7 ? 'every day' : days.length === 5 && days.every(d => d >= 1 && d <= 5) ? 'weekdays' : days.map(d => DAY_NAMES[d]).join(', ')
  return `${when} ${time}`
}

function described(task: BotTask): Record<string, string> {
  return { id: task.id, what: task.goal, when: task.schedule ? scheduleWords(task.schedule) : 'not scheduled', ...(task.lastRunAt ? { lastRun: task.lastRunAt } : {}) }
}

export function scheduleTool(deps: ScheduleDeps): AgentTool {
  return {
    name: 'schedule',
    description: 'Keep something the person wants done later in this conversation, by itself, at a set local time: action "add" with what (their request, in their words, complete enough to run alone), time "HH:MM" (24-hour) and either days (0 Sunday to 6 Saturday; all seven for every day) or date (YYYY-MM-DD) for once. At that time it runs here as a new message and they are notified. "list" shows what is kept; "remove" with id stops one. Only when they ask for something later or repeated.',
    argsSchema: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'] },
        what: { type: 'string' }, time: { type: 'string' },
        days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
        date: { type: 'string' }, id: { type: 'string' },
      },
    },
    async run(args) {
      const action = args['action']
      if (action === 'list') {
        const kept = (await deps.list()).filter(task => task.schedule && !task.routineId)
        return JSON.stringify({ scheduled: kept.map(described) })
      }
      if (action === 'remove') {
        const id = typeof args['id'] === 'string' ? args['id'] : ''
        if (!id || !await deps.remove(id)) throw new Error('No scheduled task has that id here; call schedule with action "list" for the ids.')
        return JSON.stringify({ removed: id })
      }
      if (action !== 'add') throw new Error('action is "add", "list" or "remove".')
      const what = typeof args['what'] === 'string' ? args['what'].trim() : ''
      if (!what || what.length > 500) throw new Error('what is the request to run, 1 to 500 characters.')
      const time = TIME.exec(typeof args['time'] === 'string' ? args['time'].trim() : '')
      if (!time) throw new Error('time is the local time as HH:MM, 24-hour.')
      const date = typeof args['date'] === 'string' ? args['date'].trim() : undefined
      const days = Array.isArray(args['days']) ? [...new Set(args['days'] as number[])].sort((a, b) => a - b) : []
      if (!date && !days.length) throw new Error('Give days (0 Sunday to 6 Saturday) for a repeat, or date (YYYY-MM-DD) for once.')
      const schedule: Schedule = { days: date ? [] : days, hour: Number(time[1]), minute: Number(time[2]), ...(date ? { on: date } : {}) }
      if (!isSchedule(schedule)) throw new Error('days are whole numbers 0 to 6 and date is a real day as YYYY-MM-DD.')
      const now = deps.now?.() ?? new Date()
      if (date && (date < localDay(now) || (date === localDay(now) && schedule.hour * 60 + schedule.minute < now.getHours() * 60 + now.getMinutes())))
        throw new Error(`That time has passed; it is now ${localDay(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}.`)
      const task = await deps.add({ name: what.slice(0, 60), goal: what, schedule })
      return JSON.stringify({ scheduled: described(task), note: 'Say back in one line what will run and when.' })
    },
  }
}
