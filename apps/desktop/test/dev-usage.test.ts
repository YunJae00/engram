import { expect, it } from 'vitest'
import { claudeTurnUsage, claudeUsage, codexTurnUsage, codexUsage } from '../src/main/dev-usage.js'

it('does not turn unavailable limits into zero usage or invent session costs', () => {
  expect(codexUsage({ rateLimits: null }).unavailable).toBeTruthy()
  expect(claudeUsage({ rate_limits: null }).unavailable).toBeTruthy()
  expect(codexUsage({ rateLimits: { primary: { usedPercent: null } } }).windows?.[0]?.used).toBeUndefined()
  expect(claudeUsage({ rate_limits: { five_hour: { utilization: null, resets_at: null } } }).windows?.[0]).toMatchObject({ used: undefined, resetsAt: undefined })
  expect(codexTurnUsage({ tokenUsage: { total: { inputTokens: 20, cachedInputTokens: 10, outputTokens: 5 } } })).toEqual({ input: 20, cached: 10, output: 5 })
})

it('uses provider-supplied window units and cumulative model totals', () => {
  expect(codexUsage({ rateLimitsByLimitId: { main: { primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: 123 } } } }).windows).toEqual([{ name: 'main · 5h', used: 35, resetsAt: 123000 }])
  expect(claudeUsage({ rate_limits: { five_hour: { utilization: 35, resets_at: '2026-09-20T12:00:00Z' } } }).windows?.[0]?.used).toBe(35)
  expect(claudeTurnUsage({ total_cost_usd: 0.1, modelUsage: { one: { inputTokens: 4, outputTokens: 8, cacheReadInputTokens: 2 }, two: { inputTokens: 3, outputTokens: 1 } } })).toEqual({ input: 7, output: 9, cached: 2, cost: 0.1 })
})
