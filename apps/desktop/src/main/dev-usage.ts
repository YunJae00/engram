import type { DevUsage } from '../shared/developers.js'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const percent = (value: unknown): number | undefined => { const number = count(value); return number === undefined ? undefined : Math.min(100, number) }

export function codexUsage(value: unknown): DevUsage {
  const data = record(value), buckets = record(data['rateLimitsByLimitId'])
  const limits = Object.keys(buckets).length ? Object.entries(buckets) : [['Account', data['rateLimits']]] as [string, unknown][]
  const windows: NonNullable<DevUsage['windows']> = []
  for (const [id, raw] of limits) {
    const limit = record(raw)
    for (const key of ['primary', 'secondary']) {
      if (!limit[key]) continue
      const window = record(limit[key]), minutes = count(window['windowDurationMins']), seconds = count(window['resetsAt'])
      const duration = minutes ? (minutes >= 1440 && minutes % 1440 === 0 ? `${minutes / 1440}d` : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`) : key
      windows.push({ name: `${typeof limit['limitName'] === 'string' ? limit['limitName'] : id} · ${duration}`, used: percent(window['usedPercent']), resetsAt: seconds === undefined ? undefined : seconds * 1000 })
    }
  }
  return { windows, updatedAt: Date.now(), ...(windows.length ? {} : { unavailable: 'Account limits are not available for this connection.' }) }
}

export function claudeUsage(value: unknown): DevUsage {
  const data = record(value), limits = record(data['rate_limits']), windows: NonNullable<DevUsage['windows']> = []
  for (const [key, raw] of Object.entries(limits)) {
    if (!raw || key === 'extra_usage' || key === 'model_scoped') continue
    const window = record(raw), reset = typeof window['resets_at'] === 'string' ? Date.parse(window['resets_at']) : NaN
    windows.push({ name: key.replaceAll('_', ' '), used: percent(window['utilization']), resetsAt: Number.isFinite(reset) ? reset : undefined })
  }
  return { windows, updatedAt: Date.now(), ...(windows.length ? {} : { unavailable: 'Account limits are not available for this connection.' }) }
}

export function claudeTurnUsage(value: unknown): DevUsage {
  const data = record(value), models = record(data['modelUsage'])
  let input = 0, output = 0, cached = 0, found = false
  for (const raw of Object.values(models)) {
    const model = record(raw)
    if (count(model['inputTokens']) !== undefined || count(model['outputTokens']) !== undefined) found = true
    input += count(model['inputTokens']) ?? 0
    output += count(model['outputTokens']) ?? 0
    cached += count(model['cacheReadInputTokens']) ?? 0
  }
  return { ...(found ? { input, output, cached } : {}), cost: count(data['total_cost_usd']) }
}

export function codexTurnUsage(value: unknown): DevUsage {
  const total = record(record(record(value)['tokenUsage'])['total'])
  return { input: count(total['inputTokens']), output: count(total['outputTokens']), cached: count(total['cachedInputTokens']) }
}
