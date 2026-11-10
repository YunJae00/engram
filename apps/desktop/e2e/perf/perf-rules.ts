export type Stat = { median: number; p95: number }
export type PartResult = { median: number | null; p95: number | null }
export type MetricResult = { median: number; p95: number; referenceOnly?: true; parts: Record<string, PartResult> }
export type MetricId = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8'

export const FRAME_MS = 1000 / 60
export const DROPPED_FACTOR = 1.5

// Part order matters: the first part is the metric's primary value.
export const TARGETS: Record<MetricId, Record<string, number>> = {
  P1: { interactiveMs: 2500 },
  P2: { cachedMs: 120, firstOpenMs: 250 },
  P3: { listMs: 80, firstRenderLongtasks: 0, scrollFrameMs: 20 },
  P4: { frameMs: 20, droppedPct: 5, longtasksOver100: 0, anchorPx: 2, heapMB: 200 },
  P5: { eventMs: 32, maxEventMs: 50, threadMutations: 0 },
  P6: { frameMs: 20, longtasksOver50: 0, finalLagMs: 100 },
  P7: { cpuPct: 1, memoryMB: 400, rendererMB: 200 },
  P8: { frameMs: 20, svgElements: 1500, cpuOverIdlePp: 3, unpausedAfterBlur: 0 },
}
export const P1_MEDIAN_TARGET = 1800

export function stats(values: readonly number[]): Stat {
  if (!values.length || values.some(v => !Number.isFinite(v))) throw new Error(`stats needs finite values, got ${JSON.stringify(values)}`)
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length, mid = Math.floor(n / 2)
  const median = n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  return { median, p95: sorted[Math.ceil(0.95 * n) - 1]! }
}

export function passes(value: number | null, target: number, baseline: number | undefined): boolean {
  if (value === null) return false
  if (baseline === undefined) return value <= target
  if (baseline > target) return value < baseline
  return value <= target && value <= baseline * 1.1
}

export function unstable(prev: number, cur: number): boolean {
  if (prev === 0) return cur !== 0
  return Math.abs(cur - prev) / prev > 0.15
}

export function droppedPct(intervals: readonly number[]): number {
  if (!intervals.length) throw new Error('droppedPct needs at least one interval')
  return (100 * intervals.filter(ms => ms > DROPPED_FACTOR * FRAME_MS).length) / intervals.length
}

// Per-part samples (null only where a part cannot be measured yet) → result shape.
export function summarize(id: MetricId, samples: Record<string, (number | null)[]>): MetricResult {
  const parts: Record<string, PartResult> = {}
  for (const name of Object.keys(TARGETS[id])) {
    const values = samples[name]
    if (!values?.length) throw new Error(`${id}.${name} has no samples`)
    if (values.every(v => v === null)) parts[name] = { median: null, p95: null }
    else if (values.some(v => v === null)) throw new Error(`${id}.${name} has missing samples: ${JSON.stringify(values)}`)
    else parts[name] = stats(values as number[])
  }
  const primary = parts[Object.keys(TARGETS[id])[0]!]!
  if (primary.median === null || primary.p95 === null) throw new Error(`${id} primary part is null`)
  return { median: primary.median, p95: primary.p95, parts }
}

export type Verdict = { hard: string[]; soft: string[]; referenceOnly: boolean }

// hard failures (null parts) always fail; soft ones (target or baseline misses) are waived when referenceOnly.
export function judge(id: MetricId, result: MetricResult, baseline: MetricResult | undefined, previous: MetricResult | undefined): Verdict {
  const hard: string[] = [], soft: string[] = []
  for (const [name, target] of Object.entries(TARGETS[id])) {
    const value = result.parts[name]?.p95 ?? null
    if (value === null) { hard.push(`${id}.${name} is null`); continue }
    const base = baseline?.parts[name]?.p95 ?? undefined
    if (!passes(value, target, base ?? undefined)) soft.push(`${id}.${name} p95 ${value} misses target ${target}${base === undefined || base === null ? '' : ` / baseline ${base}`}`)
  }
  if (id === 'P1' && !passes(result.median, P1_MEDIAN_TARGET, baseline?.median)) soft.push(`P1 median ${result.median} misses ${P1_MEDIAN_TARGET}${baseline ? ` / baseline ${baseline.median}` : ''}`)
  const referenceOnly = previous !== undefined && unstable(previous.median, result.median)
  return { hard, soft, referenceOnly }
}
