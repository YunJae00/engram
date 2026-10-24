// When a standing task runs, read off the times the person asked for it by
// hand: the same weekday mornings become "weekdays at 9". Local time, since
// that is the clock the person's mornings are on.

export interface Schedule {
  // Local getDay() values, sorted, unique.
  days: number[]
  hour: number
  minute: number
  // A single day (YYYY-MM-DD, local) instead of a weekly pattern: the task
  // runs once, on that day, and is then done.
  on?: string
  // Again every so many minutes on the listed days, from hour:minute on.
  every?: number
}

const WEEKDAYS = [1, 2, 3, 4, 5]
export const EVERY_MIN = 5
export const EVERY_MAX = 1440
// A task is due for two hours after its time; later than that the moment
// has passed and it waits for the next listed day.
export const DUE_WINDOW_MS = 2 * 3_600_000

export function guessSchedule(times: Date[]): Schedule {
  const hours = times.map((t) => (t.getHours() + (t.getMinutes() >= 30 ? 1 : 0)) % 24).sort((a, b) => a - b)
  const hour = hours[Math.floor((hours.length - 1) / 2)] ?? 9
  const seen = [...new Set(times.map((t) => t.getDay()))].sort((a, b) => a - b)
  const days = seen.length === 0 ? WEEKDAYS : seen.length === 1 ? seen : seen.every((d) => d >= 1 && d <= 5) ? WEEKDAYS : seen
  return { days, hour, minute: 0 }
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function isSchedule(value: unknown): value is Schedule {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    Array.isArray(s['days']) &&
    s['days'].every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) &&
    Number.isInteger(s['hour']) &&
    (s['hour'] as number) >= 0 &&
    (s['hour'] as number) <= 23 &&
    Number.isInteger(s['minute']) &&
    (s['minute'] as number) >= 0 &&
    (s['minute'] as number) <= 59 &&
    (s['every'] === undefined || (s['on'] === undefined && Number.isInteger(s['every']) && (s['every'] as number) >= EVERY_MIN && (s['every'] as number) <= EVERY_MAX)) &&
    (s['on'] === undefined || (typeof s['on'] === 'string' && DAY.test(s['on']) && !Number.isNaN(Date.parse(s['on'])) && new Date(s['on']).toISOString().slice(0, 10) === s['on']))
  )
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Due: a listed day (or the one day it is for), inside the window after the
// time, and not already run today.
export function dueNow(schedule: Schedule, lastRunAt: string | undefined, now: Date): boolean {
  if (schedule.on ? schedule.on !== localDay(now) : !schedule.days.includes(now.getDay())) return false
  const at = new Date(now)
  at.setHours(schedule.hour, schedule.minute, 0, 0)
  const since = now.getTime() - at.getTime()
  // The tick is a minute, so a run a few seconds late still counts as on time.
  if (schedule.every) return since >= 0 && (!lastRunAt || now.getTime() - Date.parse(lastRunAt) >= schedule.every * 60_000 - 30_000)
  if (since < 0 || since > DUE_WINDOW_MS) return false
  if (lastRunAt && sameLocalDay(new Date(lastRunAt), now)) return false
  return true
}

// A one-day schedule whose day is behind us will never be due again.
export function scheduleOver(schedule: Schedule, now: Date): boolean {
  if (!schedule.on) return false
  const end = new Date(`${schedule.on}T00:00:00`)
  end.setHours(schedule.hour, schedule.minute, 0, 0)
  return now.getTime() - end.getTime() > DUE_WINDOW_MS
}
