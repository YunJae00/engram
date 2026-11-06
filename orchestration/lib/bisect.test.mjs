import { describe, it, expect } from 'vitest'
import { culprits, revertPlan } from './bisect.mjs'

const merged = [
  { id: 'one', mergeSha: '1', scenarios: ['open-vault'], criteria: [] },
  { id: 'two', mergeSha: '2', scenarios: [], criteria: [{ id: 'c', cmd: 'node scripts/verify-cli.mjs capture', expect: '0' }] },
  { id: 'three', mergeSha: '3', scenarios: [], criteria: [{ id: 'c', cmd: 'npm test', expect: '0' }] },
]

describe('culprits', () => {
  it('maps failed scenarios to items naming them in scenarios or criteria', () => {
    expect(culprits(['open-vault'], merged)).toEqual(['one'])
    expect(culprits(['capture', 'open-vault'], merged)).toEqual(['one', 'two'])
    expect(culprits(['unknown'], merged)).toEqual([])
  })
})

describe('revertPlan', () => {
  it('puts known culprits first', () => {
    expect(revertPlan(merged, ['one']).map((step) => step.id)).toEqual(['one', 'three', 'two'])
  })

  it('falls back to reverse merge order one at a time', () => {
    expect(revertPlan(merged, [])).toEqual([
      { id: 'three', mergeSha: '3' },
      { id: 'two', mergeSha: '2' },
      { id: 'one', mergeSha: '1' },
    ])
  })
})
