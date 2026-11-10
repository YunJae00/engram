import { threadWords, type ThreadLang } from './threadLang.js'

export const DIVIDER_GAP_MS = 15 * 60 * 1000

const timeOf = (at: unknown): number | null => {
  if (typeof at !== 'string') return null
  const t = Date.parse(at)
  return Number.isFinite(t) ? t : null
}

// One flag per message: a time divider goes above it when it came at least
// DIVIDER_GAP_MS after the last message with a valid time.
export function dividerBefore(messages: readonly { at?: string }[]): boolean[] {
  const out: boolean[] = []
  let last: number | null = null
  for (let i = 0; i < messages.length; i++) {
    const t = timeOf(messages[i]!.at)
    out.push(i > 0 && t !== null && last !== null && t - last >= DIVIDER_GAP_MS)
    if (t !== null) last = t
  }
  return out
}

export function dividerLabel(at: string, lang: ThreadLang, now: Date): string {
  const d = new Date(Date.parse(at))
  const locale = lang === 'ko' ? 'ko-KR' : 'en-US'
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate())
    return `${threadWords(lang).today} ${new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(d)}`
  return new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}) }).format(d)
}
