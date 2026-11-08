import { describe, expect, it } from 'vitest'
import { openRuleLines } from '../src/agent-prompt.js'

describe('a comet speaks to the person, not about them', () => {
  it('the open rules ask for direct, first-person progress lines and forbid third-person narration', () => {
    const rule = openRuleLines().find((line) => line.startsWith('Speak to the person directly'))
    expect(rule).toBeDefined()
    expect(rule).toMatch(/first person/)
    expect(rule).toMatch(/never about them in the third person/)
    expect(rule).toContain('사용자가')
    expect(rule).toContain('The user asked')
  })
})
