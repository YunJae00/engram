import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const system = vi.hoisted(() => ({ free: vi.fn(() => 0.29e9), total: vi.fn(() => 8.59e9), stats: vi.fn() }))
vi.mock('node:os', () => ({ default: { freemem: system.free, totalmem: system.total } }))
vi.mock('node:child_process', () => ({ execFileSync: system.stats }))

beforeEach(() => {
  vi.resetModules()
  system.stats.mockReset()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})
afterEach(() => vi.restoreAllMocks())

it('admits a Mac with little idle RAM but reclaimable cache, without double-counting purgeable pages', async () => {
  system.stats.mockReturnValue('page size of 16384 bytes\nPages free: 10000.\nPages speculative: 10000.\nPages inactive: 150000.\nPages purgeable: 5000.\nFile-backed pages: 180000.\n')
  const { availableMemory } = await import('../src/main/available-memory.js')
  expect(availableMemory()).toBe(170000 * 16384)
  expect(availableMemory()).toBeGreaterThan(1.2e9)
  expect(system.stats).toHaveBeenCalledOnce()
})

it('keeps the conservative free-memory fallback when the Mac measurement fails', async () => {
  system.stats.mockImplementation(() => { throw new Error('vm_stat unavailable') })
  const { availableMemory } = await import('../src/main/available-memory.js')
  expect(availableMemory()).toBe(system.free())
})

it('preserves Windows memory accounting without invoking vm_stat', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  const { availableMemory } = await import('../src/main/available-memory.js')
  expect(availableMemory()).toBe(system.free())
  expect(system.stats).not.toHaveBeenCalled()
})
