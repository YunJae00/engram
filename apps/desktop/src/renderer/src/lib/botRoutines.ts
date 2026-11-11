export const EVERY_MIN = 5
export const EVERY_MAX = 1440
export const DUE_WINDOW_MS = 7_200_000

const DAY = /^\d{4}-\d{2}-\d{2}$/

type Rec = Record<string, unknown>
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null
const inRange = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && (value as number) >= min && (value as number) <= max

export function validSchedule(value: unknown): boolean {
  if (!isRec(value)) return false
  const days = value['days']
  if (!Array.isArray(days)) return false
  for (let i = 0; i < days.length; i++) if (!inRange(days[i], 0, 6)) return false
  if (!inRange(value['hour'], 0, 23) || !inRange(value['minute'], 0, 59)) return false
  const every = value['every'], on = value['on']
  if (every !== undefined && !(on === undefined && inRange(every, EVERY_MIN, EVERY_MAX))) return false
  if (on === undefined) return true
  return typeof on === 'string' && DAY.test(on) && !Number.isNaN(Date.parse(on)) && new Date(on).toISOString().slice(0, 10) === on
}

const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()

export function nextRun(schedule: unknown, lastRunAt: unknown, now: Date): Date | null {
  if (!validSchedule(schedule)) return null
  const s = schedule as { days: number[]; hour: number; minute: number; on?: string; every?: number }
  const last = typeof lastRunAt === 'string' && Number.isFinite(Date.parse(lastRunAt)) ? new Date(Date.parse(lastRunAt)) : null
  if (s.on !== undefined) {
    const at = new Date(`${s.on}T00:00:00`)
    at.setHours(s.hour, s.minute, 0, 0)
    if (last && sameDay(last, at)) return null
    if (now.getTime() - at.getTime() > DUE_WINDOW_MS) return null
    return at
  }
  for (let d = 0; d <= 7; d++) {
    const c = new Date(now)
    c.setDate(c.getDate() + d)
    c.setHours(s.hour, s.minute, 0, 0)
    if (!s.days.includes(c.getDay())) continue
    if (c > now) return c
    if (d !== 0) continue
    if (s.every) {
      const n = last ? new Date(Math.max(c.getTime(), last.getTime() + s.every * 60_000)) : c
      if (sameDay(n, now)) return n
    } else if (now.getTime() - c.getTime() <= DUE_WINDOW_MS && !(last && sameDay(last, now))) return c
  }
  return null
}

interface RoutineRow { id: string; name: string; paused: boolean; routineId: string | null; next: Date | null }

export function routineRows(tasks: unknown, now: Date): RoutineRow[] {
  const rows: RoutineRow[] = []
  if (!Array.isArray(tasks)) return rows
  for (let i = 0; i < tasks.length; i++) {
    const task: unknown = tasks[i]
    if (!isRec(task)) continue
    const id = task['id'], name = task['name'], routineId = task['routineId']
    if (typeof id !== 'string' || !id || typeof name !== 'string' || !name) continue
    const paused = task['paused'] === true
    const next = paused || task['schedule'] === undefined ? null : nextRun(task['schedule'], task['lastRunAt'], now)
    rows.push({ id, name, paused, routineId: typeof routineId === 'string' && routineId ? routineId : null, next })
  }
  return rows
}

type RunState = 'running' | 'succeeded' | 'failed'
interface RunEntry { id: string; state: RunState; at: string }

const STATES: Record<string, RunState> = { queued: 'running', running: 'running', waiting: 'running', done: 'succeeded', failed: 'failed' }

export function runHistory(tasks: unknown, botId: string): RunEntry[] {
  const kept: { entry: RunEntry; time: number }[] = []
  if (!Array.isArray(tasks)) return []
  for (let i = 0; i < tasks.length; i++) {
    const task: unknown = tasks[i]
    if (!isRec(task) || task['botId'] !== botId || typeof task['id'] !== 'string') continue
    const at = task['createdAt'], raw = task['state']
    const time = typeof at === 'string' ? Date.parse(at) : NaN
    const state = typeof raw === 'string' && Object.hasOwn(STATES, raw) ? STATES[raw] : undefined
    if (!Number.isFinite(time) || !state) continue
    kept.push({ entry: { id: task['id'], state, at: at as string }, time })
  }
  return kept.sort((a, b) => b.time - a.time).slice(0, 20).map(k => k.entry)
}

export function formatRun(date: Date, lang: 'ko' | 'en'): string {
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date)
}
