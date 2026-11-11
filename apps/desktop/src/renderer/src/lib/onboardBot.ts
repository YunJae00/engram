import { clipLabel } from './createBot.js'

// The onboarding renderer is replaced by onboard:complete, so the first-bot choice crosses the reload here.
export const ONBOARD_BOT_KEY = 'engram.onboardBot'

export type OnboardBot = { name: string | null; label: string | null }

const field = (value: unknown): string | null | undefined =>
  value === null ? null : typeof value === 'string' ? value.trim() || null : undefined

export function readOnboardBot(raw: string | null): OnboardBot | null {
  if (!raw) return null
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const { name, label } = parsed as Record<string, unknown>
  const cleanName = field(name), cleanLabel = field(label)
  if (cleanName === undefined || cleanLabel === undefined) return null
  return { name: cleanName === null ? null : cleanName.slice(0, 60), label: cleanLabel === null ? null : clipLabel(cleanLabel) }
}

export function saveOnboardBot(bot: OnboardBot): void {
  localStorage.setItem(ONBOARD_BOT_KEY, JSON.stringify(bot))
}

export function takeOnboardBot(): OnboardBot | null {
  const raw = localStorage.getItem(ONBOARD_BOT_KEY)
  localStorage.removeItem(ONBOARD_BOT_KEY)
  return readOnboardBot(raw)
}
