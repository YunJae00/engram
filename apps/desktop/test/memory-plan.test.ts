import { describe, expect, it } from 'vitest'
import { CRITICAL_FLOOR, planModelLoad, PRESSURE_FLOOR, ROOM_FOR_BROWSER } from '../src/main/memory-plan.js'

const GB = 1e9
const MODEL = 5 * GB
const HUGE = 16.9 * GB

// The plan is what stands between "load the model" and "freeze the machine":
// the tiers must degrade before the system does.

describe('planModelLoad', () => {
  it('a comfortable machine gets full GPU offload', () => {
    expect(planModelLoad(MODEL, 20 * GB).mode).toBe('gpu')
  })

  it('a busy machine offloads partially, behind a larger reserve', () => {
    const plan = planModelLoad(MODEL, 12 * GB)
    expect(plan.mode).toBe('lean')
    expect(plan.gpuLayers).toBe('auto')
    expect(plan.vramPadding).toBeGreaterThan(planModelLoad(MODEL, 20 * GB).vramPadding)
  })

  it('the load is planned from its full cost, not the file size', () => {
    // Measured: a 5GB file consumed 6.8GB pinned once KV cache and buffers
    // arrived, so 9.9GB free must never approve an offload again.
    const plan = planModelLoad(MODEL, 9.9 * GB)
    expect(plan.mode).toBe('cpu')
    expect(plan.gpuLayers).toBe(0)
  })

  it('a tight machine keeps every weight evictable — zero pinned memory', () => {
    const plan = planModelLoad(MODEL, 6.5 * GB)
    expect(plan.mode).toBe('cpu')
    expect(plan.gpuLayers).toBe(0)
    expect(plan.vramPadding).toBe(0)
  })

  it('an exhausted machine is refused, with the number it would need', () => {
    const plan = planModelLoad(MODEL, 3 * GB)
    expect(plan.mode).toBe('none')
    expect(plan.reason).toMatch(/needs ~6\.0GB/)
  })

  it('a 17GB model on a 32GB machine never pins — cpu at best, refused when tight', () => {
    expect(planModelLoad(HUGE, 14 * GB).mode).toBe('cpu')
    // Typical working free memory on the measured machine: refused outright.
    expect(planModelLoad(HUGE, 12 * GB).mode).toBe('none')
  })

  it('tiers are monotonic in free memory — more room never downgrades', () => {
    const order = ['none', 'cpu', 'lean', 'gpu']
    let last = -1
    for (let free = 1 * GB; free <= 24 * GB; free += GB) {
      const at = order.indexOf(planModelLoad(MODEL, free).mode)
      expect(at).toBeGreaterThanOrEqual(last)
      last = at
    }
  })
})

// The freeze happens where pages cannot be reclaimed, so the floors have to
// fire in order: give the room back first, kill the worker only at the end.
describe('the floors', () => {
  it('ask before killing, and clear the room before a browser opens', () => {
    expect(CRITICAL_FLOOR).toBeLessThan(PRESSURE_FLOOR)
    expect(PRESSURE_FLOOR).toBeLessThan(ROOM_FOR_BROWSER)
  })

  it('an approved offload always leaves the machine above the critical floor', () => {
    for (let free = 1 * GB; free <= 32 * GB; free += 0.5 * GB) {
      const plan = planModelLoad(MODEL, free)
      if (plan.mode !== 'gpu' && plan.mode !== 'lean') continue
      // What the load itself costs is the file plus the buffers riding with
      // it; whatever is left has to stay clear of the floor.
      expect(free - (MODEL + 2 * GB)).toBeGreaterThanOrEqual(CRITICAL_FLOOR)
    }
  })
})

// Evictable weights are safe and, on a machine whose standby cache is full,
// seven seconds a token. With real room they are pinned; without it, not.
describe('pinning on the CPU side', () => {
  it('pins only with the model plus a margin free, and never on an offload', () => {
    expect(planModelLoad(MODEL, 10 * GB)).toMatchObject({ mode: 'cpu', lock: true })
    expect(planModelLoad(MODEL, 7 * GB)).toMatchObject({ mode: 'cpu', lock: false })
    expect(planModelLoad(MODEL, 20 * GB).lock).toBe(false)
  })
})
