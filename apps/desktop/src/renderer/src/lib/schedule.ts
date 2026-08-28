import type { ScheduleDto } from '../../../shared/types.js'
import { t } from '../i18n.js'

// How a schedule reads to a person: "every weekday at 9:00".
export function timeLabel(hour: number, minute: number): string {
  return `${hour}:${minute.toString().padStart(2, '0')}`
}

export function scheduleLabel(s: ScheduleDto): string {
  const time = timeLabel(s.hour, s.minute)
  const days = [...s.days].sort((a, b) => a - b)
  if (days.length === 7) return t('schedule.daily', { time })
  if (days.length === 5 && days.every((d) => d >= 1 && d <= 5)) return t('schedule.weekdays', { time })
  const names = t('schedule.dayNames').split(',')
  if (days.length === 1) return t('schedule.weekly', { day: names[days[0]!] ?? '', time })
  return t('schedule.days', { days: days.map((d) => names[d] ?? '').join(', '), time })
}

export function timesLabel(count: number): string {
  if (count === 2) return t('bots.timesTwice')
  if (count === 3) return t('bots.timesThree')
  return t('bots.timesN', { n: count })
}
