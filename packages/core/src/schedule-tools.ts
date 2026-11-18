import type { AgentTool } from './agent-loop.js'
import type { BotTask, TaskWatch } from './bots.js'
import { EVERY_MAX, EVERY_MIN, isSchedule, localDay, type Schedule } from './schedule.js'

export interface ScheduleDeps {
  list(): Promise<BotTask[]>
  add(input: { name: string; goal: string; schedule: Schedule; watch?: TaskWatch }): Promise<BotTask>
  remove(id: string): Promise<boolean>
  watchable?: string[]
  now?(): Date
  duty?: true
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

const DAY_KO = ['일', '월', '화', '수', '목', '금', '토']
const timeKo = (hour: number, minute: number): string => `${hour === 0 ? '밤 12' : hour < 6 ? `새벽 ${hour}` : hour < 12 ? hour : hour === 12 ? '낮 12' : `오후 ${hour - 12}`}시${minute === 30 ? ' 반' : minute ? ` ${minute}분` : ''}`
export function scheduleWordsKo(schedule: Schedule): string {
  const time = timeKo(schedule.hour, schedule.minute)
  if (schedule.on) return `${schedule.on} ${time}에 한 번`
  const days = [...schedule.days].sort((a, b) => a - b)
  const when = days.length === 7 ? '매일' : days.length === 5 && days.every(d => d >= 1 && d <= 5) ? '평일' : `매주 ${days.map(d => DAY_KO[d]).join('·')}요일`
  return schedule.every ? `${when} ${time}부터 ${schedule.every}분마다` : `${when} ${time}`
}

function keptLine(schedule: Schedule, what: string): string {
  const when = scheduleWordsKo(schedule), asked = /^(.*[가-힣])\s*(?:줘요?|주세요|줄래요?)[.!~\s]*$/u.exec(what.trim())?.[1]
  const open = asked ? (asked.charCodeAt(asked.length - 1) - 0xac00) % 28 === 0 : false
  if (schedule.on || schedule.every || !asked || !open || asked.includes('\n')) return `${when}${schedule.on || schedule.every ? '' : '에'} 할게요: "${what}"`
  return `${when}에 ${asked} 드릴게요.`
}

const PLAIN_REPEAT = /^(매주\s*([월화수목금토일])요일(?:\s*마다)?|매일|평일\s*마다|주말\s*마다)\s*(아침|오전|낮|오후|저녁|밤)?\s*(\d{1,2})\s*시\s*(?:(\d{1,2})\s*분|(반))?\s*(?:에|마다)?\s+(.+)$/u
const ASKS_FOR = /(줘요?|주세요|줄래요?|해|해요)[.!~\s]*$/u
const NOT_PLAIN = /지금|먼저|매주|매일|마다|\d\s*시|보내|올려|전송|게시|공유/u
export function plainSchedule(message: string): { action: 'add'; what: string; time: string; days: number[] } | undefined {
  const line = message.trim(), said = line.length <= 200 && !line.includes('\n') ? PLAIN_REPEAT.exec(line) : null
  if (!said) return undefined
  const [, repeat, day, part, hours, minutes, half, what] = said as unknown as [string, string, string | undefined, string | undefined, string, string | undefined, string | undefined, string]
  const n = Number(hours), minute = half ? 30 : Number(minutes ?? 0)
  const hour = part === '아침' || part === '오전' ? (n === 12 ? 0 : n <= 11 ? n : -1)
    : part === '낮' ? (n === 12 ? 12 : n <= 5 ? n + 12 : -1)
    : part === '밤' ? (n === 12 ? 0 : n <= 4 ? n : n <= 11 ? n + 12 : -1)
    : part ? (n <= 11 ? n + 12 : n === 12 ? 12 : -1)
    : n >= 7 && n <= 23 ? n : -1
  if (hour < 0 || n < 1 || minute > 59 || !ASKS_FOR.test(what) || NOT_PLAIN.test(what)) return undefined
  const days = day ? [DAY_KO.indexOf(day)] : repeat.startsWith('평일') ? [1, 2, 3, 4, 5] : repeat.startsWith('주말') ? [0, 6] : [0, 1, 2, 3, 4, 5, 6]
  return { action: 'add', what: what.trim(), time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`, days }
}

function described(task: BotTask, korean = false): Record<string, string> {
  return { id: task.id, what: task.goal, when: task.schedule ? (korean ? scheduleWordsKo : scheduleWords)(task.schedule) : 'not scheduled', ...(task.watch ? { onlyWhenNew: task.watch.tool } : {}), ...(task.lastRunAt ? { lastRun: task.lastRunAt } : {}) }
}

export function scheduleFrom(args: Record<string, unknown>, now: Date): Schedule {
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
  if (date && (date < localDay(now) || (date === localDay(now) && schedule.hour * 60 + schedule.minute < now.getHours() * 60 + now.getMinutes())))
    throw new Error(`That time has passed; it is now ${localDay(now)} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}.`)
  return schedule
}

export function scheduleTool(deps: ScheduleDeps): AgentTool {
  const watchable = deps.watchable ?? []
  const watchNote = watchable.length ? ` onlyWhenNew {tool, args} (tool one of ${watchable.join(', ')}, args as that tool takes them) makes each run wait until that listing shows items not seen at the last run; the new items come with the request.` : ''
  return {
    name: 'schedule',
    ...(deps.duty ? { closes: (args: Record<string, unknown>) => args['action'] === 'add' } : {}),
    description: `Keep something the person wants done later, by itself, at a set local time: action "add" with what (their request, in their words, complete enough to run alone in a new conversation), time "HH:MM" (24-hour) and either days (0 Sunday to 6 Saturday; all seven for every day) or date (YYYY-MM-DD) for once. every (minutes, ${EVERY_MIN} to ${EVERY_MAX}) repeats it on those days from that time, answering in one conversation.${watchNote} At that time it runs in a new conversation and the result waits in their notifications (the bell by the search box). "list" shows everything kept; "remove" with id stops one. Only when they ask for something later or repeated. ${deps.duty ? 'Recurring work for the team ("매주 월요일 9시에 AI 뉴스 정리해줘") is kept the same way, an ordinary schedule; it runs in this conversation, and the reply to "add" is shown to the person as your answer and ends the turn. When the same sentence also asks for something now ("지금 슬랙에 올리고 매주 월요일 9시에도 올려"), do that first, then add. "내 일정 뭐 있어?" asks for "list".' : 'Kept on this bot; when they ask for a new bot to do it, use new_bot instead.'}`,
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
        return JSON.stringify({ scheduled: kept.map(task => described(task, deps.duty)) })
      }
      if (action === 'remove') {
        const id = typeof args['id'] === 'string' ? args['id'] : ''
        if (!id || !await deps.remove(id)) throw new Error('No scheduled task has that id here; call schedule with action "list" for the ids.')
        return JSON.stringify({ removed: id })
      }
      if (action !== 'add') throw new Error('action is "add", "list" or "remove".')
      const what = typeof args['what'] === 'string' ? args['what'].trim() : ''
      if (!what || what.length > 500) throw new Error('what is the request to run, 1 to 500 characters.')
      const schedule = scheduleFrom(args, deps.now?.() ?? new Date())
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
      const task = await deps.add({ name: what.slice(0, 60), goal: what, schedule, ...(watch ? { watch } : {}) })
      if (deps.duty) return keptLine(schedule, what)
      return JSON.stringify({ scheduled: described(task), note: 'Say back in one line what will run and when.' })
    },
  }
}
