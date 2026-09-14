import { describe, expect, it } from 'vitest'
import { describeTarget } from '../src/main/routine-driver.js'

describe('describeTarget', () => {
  it('prefers the human words, falls back to the first selector', () => {
    expect(describeTarget({ text: 'Submit', css: ['#s'] })).toBe('Submit')
    expect(describeTarget({ css: ['#s'] })).toBe('#s')
    expect(describeTarget({})).toBe('the element')
  })
})
