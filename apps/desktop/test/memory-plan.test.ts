import { describe, expect, it } from 'vitest'
import { planModelLoad } from '../src/main/memory-plan.js'

const GB = 1e9
const E4B = 5 * GB
const HUGE = 16.9 * GB

// The plan is what stands between "load the model" and "freeze the machine":
// the tiers must degrade before the system does.

describe('planModelLoad', () => {
  it('a comfortable machine gets full GPU offload', () => {
    expect(planModelLoad(E4B, 20 * GB).mode).toBe('gpu')
  })

  it('a busy machine offloads partially, behind a larger reserve', () => {
    const plan = planModelLoad(E4B, 9 * GB)
    expect(plan.mode).toBe('lean')
    expect(plan.gpuLayers).toBe('auto')
    expect(plan.vramPadding).toBeGreaterThan(planModelLoad(E4B, 20 * GB).vramPadding)
  })

  it('a tight machine keeps every weight evictable — zero pinned memory', () => {
    const plan = planModelLoad(E4B, 5 * GB)
    expect(plan.mode).toBe('cpu')
    expect(plan.gpuLayers).toBe(0)
    expect(plan.vramPadding).toBe(0)
  })

  it('an exhausted machine is refused, with the number it would need', () => {
    const plan = planModelLoad(E4B, 2 * GB)
    expect(plan.mode).toBe('none')
    expect(plan.reason).toMatch(/needs ~4\.0GB/)
  })

  it('a 17GB model on a 32GB machine lands in cpu mode, never pinned', () => {
    // Typical working free memory on the measured machine.
    const plan = planModelLoad(HUGE, 12 * GB)
    expect(plan.mode).toBe('cpu')
  })

  it('tiers are monotonic in free memory — more room never downgrades', () => {
    const order = ['none', 'cpu', 'lean', 'gpu']
    let last = -1
    for (let free = 1 * GB; free <= 24 * GB; free += GB) {
      const at = order.indexOf(planModelLoad(E4B, free).mode)
      expect(at).toBeGreaterThanOrEqual(last)
      last = at
    }
  })
})
