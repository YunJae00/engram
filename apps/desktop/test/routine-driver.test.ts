import { describe, expect, it } from 'vitest'
import { describeTarget, targetPlan } from '../src/main/routine-driver.js'

describe('targetPlan', () => {
  it('tries saved selectors before the visible text', () => {
    const plan = targetPlan({ css: ['#submit', '.btn-primary'], text: 'Submit' }, 'click')
    expect(plan.map((p) => p.via)).toEqual(['css', 'css', 'role-button', 'role-link', 'text'])
    expect(plan[0]).toEqual({ via: 'css', css: '#submit' })
  })

  it('click and type probe different element families for the same words', () => {
    const click = targetPlan({ text: 'Title' }, 'click').map((p) => p.via)
    const type = targetPlan({ text: 'Title' }, 'type').map((p) => p.via)
    expect(click).toEqual(['role-button', 'role-link', 'text'])
    expect(type).toEqual(['label', 'placeholder', 'role-textbox'])
  })

  it('blank selector entries and blank text produce no probes', () => {
    expect(targetPlan({ css: ['  '], text: '  ' }, 'click')).toEqual([])
  })
})

describe('describeTarget', () => {
  it('prefers the human words, falls back to the first selector', () => {
    expect(describeTarget({ text: 'Submit', css: ['#s'] })).toBe('Submit')
    expect(describeTarget({ css: ['#s'] })).toBe('#s')
    expect(describeTarget({})).toBe('the element')
  })
})
