import type { WebCourier } from './errand.js'

export interface HarnessMetric {
  kind: 'browser' | 'tool' | 'model' | 'turn' | 'observation' | 'batch'
  operation?: string
  ms?: number
  fullChars?: number
  sentChars?: number
  completed?: number
  requested?: number
}

// Metrics contain timings and counts, never page contents, arguments or addresses.
export function measuredCourier(courier: WebCourier, emit?: (metric: HarnessMetric) => void): WebCourier {
  if (!emit) return courier
  const measured = Object.create(courier) as WebCourier
  for (const key of ['fetchPage', 'readOpen', 'press', 'typeText', 'choose', 'scroll', 'hover', 'pressKey', 'pressPoint', 'reveal', 'look'] as const) {
    const call = courier[key]
    if (!call) continue
    Object.defineProperty(measured, key, { value: async (...args: unknown[]) => {
      const start = performance.now()
      try { return await Reflect.apply(call, courier, args) }
      finally { emit({ kind: 'browser', operation: key, ms: Math.round(performance.now() - start) }) }
    } })
  }
  return measured
}
