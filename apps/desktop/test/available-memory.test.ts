import { expect, it } from 'vitest'
import { macAvailableMemory } from '../src/main/available-memory.js'
it.each([4096, 16384])('counts reclaimable memory at the native %i-byte page size without counting wired memory', page => {
  const sample = `Mach Virtual Memory Statistics: (page size of ${page} bytes)\nPages free: 10.\nPages speculative: 20.\nPages inactive: 100.\nPages wired down: 9000.\n`
  expect(macAvailableMemory(sample)).toBe(130 * page)
})
it('fails conservatively on missing, malformed, or unsupported counters', () => {
  expect(macAvailableMemory('page size of 16384 bytes\nPages free: 10.')).toBeUndefined()
  expect(macAvailableMemory('page size of 16384 bytes\nPages free: -1.\nPages speculative: 0.\nPages inactive: 10.')).toBeUndefined()
})
