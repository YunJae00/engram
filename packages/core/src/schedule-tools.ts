import type { AgentTool } from './agent-loop.js'
import type { BotTask, TaskWatch } from './bots.js'
import { EVERY_MAX, EVERY_MIN, isSchedule, localDay, type Schedule } from './schedule.js'

// What a person asks to have done later - "every weekday at 9, sum up my
// mail" or "tomorrow at 3, remind me to call". At its time the words start
// a new conversation and run as a turn like any other; the result waits in
// the person's inbox.
export interface ScheduleDeps {
  list(): Promise<BotTask[]>
  add(input: { name: string; goal: string; schedule: Schedule; watch?: TaskWatch }): Promise<BotTask>
  remove(id: string): Promise<boolean>
  // Read-only listing tools the host can look at by itself before a run.
  watchable?: string[]
  now?(): Date
}

const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function scheduleWords(schedule: Schedule): string {
  const time = `${String(schedule.hour).padStart(2, '0')}:${String(schedule.minute).padStart(2, '0')}`
  if (schedule.on) return `${schedule.on} ${time}, once`
  const days = [...schedule.days].sort((a, b) => a - b)
  const when = days.length === 7 ? 'every day' : days.length === 5 && days.every(d => d >= 1 && d <= 5) ? 'weekdays' : days.map(d => DAY_NAMES[d]).join(', ')
  return schedule.every ? `${when} every ${schedule.every} min from ${time}` : `${when} ${time}`
}

function described(task: BotTask): Record<string, string> {
  return { id: task.id, what: task.goal, when: task.schedule ? scheduleWords(task.schedule) : 'not scheduled', ...(task.watch ? { onlyWhenNew: task.watch.tool } : {}), ...(task.lastRunAt ? { lastRun: task.lastRunAt } : {}) }
}

export function scheduleTool(deps: ScheduleDeps): AgentTool {
  const watchable = deps.watchable ?? []
  const watchNote = watchable.length ? ` onlyWhenNew {tool, args} (tool one of ${watchable.join(', ')}, args as that tool takes them) makes each run wait until that listing shows items not seen at the last run; the new items come with the request.` : ''
  return {
    name: 'schedule',
    description: `Keep something the person wants done later, by itself, at a set local time: action "add" with what (their request, in their words, complete enough to run alone in a new conversation), time "HH:MM" (24-hour) and either days (0 Sunday to 6 Saturday; all seven for every day) or date (YYYY-MM-DD) for once. every (minutes, ${EVERY_MIN} to ${EVERY_MAX}) repeats it on those days from that time, answering in one conversation.${watchNote} At that time it runs in a new conversation and the result waits in their notifications (the bell by the search box). "list" shows everything kept; "remove" with id stops one. Only when they ask for something later or repeated.`,
    argsSchema: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['add', 'list', 'remove'] },
        what: { type: 'string' }, time: { type: 'string' },
        days: { type: 'array', items: { type: 'integer', minimum: 0, maximum: 6 } },
        date: { type: 'string' }, id: { type: 'string' },
        every: { type: 'integer', minimum: EVERY_MIN, maximum: EVERY_MAX },
        ...(watchable.length ? { onlyWhenNew: { type: 'object', additionalProperties: false, required: ['tool'], properties: { tool: { type: 'string', enum: watchable }, args: { type: 'object' } } } } : {}),
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
      const every = args['every']
      if (every !== undefined && (!Number.isInteger(every) || (every as number) < EVERY_MIN || (every as number) > EVERY_MAX)) throw new Error(`every is whole minutes, ${EVERY_MIN} to ${EVERY_MAX}.`)
      const time = TIME.exec(typeof args['time'] === 'string' ? args['time'].trim() : every !== undefined && args['time'] === undefined ? '00:00' : '')
      if (!time) throw new Error('time is the local time as HH:MM, 24-hour.')
      const date = typeof args['date'] === 'string' ? args['date'].trim() : undefined
      if (date && every !== undefined) throw new Error('every repeats on days; leave date out.')
      const days = Array.isArray(args['days']) ? [...new Set(args['days'] as number[])].sort((a, b) => a - b) : every !== undefined ? [0, 1, 2, 3, 4, 5, 6] : []
      if (!date && !days.length) throw new Error('Give days (0 Sunday to 6 Saturday) for a repeat, or date (YYYY-MM-DD) for once.')
      const schedule: Schedule = { days: date ? [] : days, hour: Number(time[1]), minute: Number(time[2]), ...(date ? { on: date } : {}), ...(every !== undefined ? { every: every as number } : {}) }
      if (!isSchedule(schedule)) throw new Error('days are whole numbers 0 to 6 and date is a real day as YYYY-MM-DD.')
      const asked = args['onlyWhenNew']
      let watch: TaskWatch | undefined
      if (asked !== undefined) {
        const record = typeof asked === 'object' && asked !== null && !Array.isArray(asked) ? asked as Record<string, unknown> : {}
        const tool = typeof record['tool'] === 'string' ? record['tool'] : ''
        if (!watchable.includes(tool)) throw new Error(watchable.length ? `onlyWhenNew.tool is one of ${watchable.join(', ')}.` : 'Nothing can be watched here.')
        const toolArgs = record['args'] ?? {}
        if (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs)) throw new Error('onlyWhenNew.args is an object.')
        watch = { tool, args: toolArgs as Record<string, unknown> }
      }
      const now = deps.now?.() ?? new Date()
      if (date && (date < localDay(now) || (date === localDay(now) && schedule.hour * 60 + schedule.minute < now.getHours() * 60 + now.getMinutes())))
        throw new Error(`That time has passed; it is now ${localDay(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}.`)
      const task = await deps.add({ name: what.slice(0, 60), goal: what, schedule, ...(watch ? { watch } : {}) })
      return JSON.stringify({ scheduled: described(task), note: 'Say back in one line what will run and when.' })
    },
  }
}
