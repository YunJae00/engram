// When a standing task runs, read off the times the person asked for it by
// hand: the same weekday mornings become "weekdays at 9". Local time, since
// that is the clock the person's mornings are on.

export interface Schedule {
  // Local getDay() values, sorted, unique.
  days: number[]
  hour: number
  minute: number
}

const WEEKDAYS = [1, 2, 3, 4, 5]
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

export function isSchedule(value: unknown): value is Schedule {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  return (
    Array.isArray(s['days']) &&
    s['days'].every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) &&
    Number.isInteger(s['hour']) &&
    (s['hour'] as number) >= 0 &&
    (s['hour'] as number) <= 23 &&
    (s['minute'] === 0 || s['minute'] === 30)
  )
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

// Due: a listed day, inside the window after the time, and not already run
// today.
export function dueNow(schedule: Schedule, lastRunAt: string | undefined, now: Date): boolean {
  if (!schedule.days.includes(now.getDay())) return false
  const at = new Date(now)
  at.setHours(schedule.hour, schedule.minute, 0, 0)
  const since = now.getTime() - at.getTime()
  if (since < 0 || since > DUE_WINDOW_MS) return false
  if (lastRunAt && sameLocalDay(new Date(lastRunAt), now)) return false
  return true
}
