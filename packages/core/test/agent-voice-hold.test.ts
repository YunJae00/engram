import { describe, expect, it } from 'vitest'
import { openRuleLines } from './rules.js'

describe('a comet answers a hold in its own voice', () => {
  const rule = openRuleLines().find((line) => line.startsWith('Speak to the person directly'))

  it('applies the direct-voice rule to every reply, final answers and hold acknowledgements included', () => {
    expect(rule).toBeDefined()
    expect(rule).toMatch(/every reply/)
    expect(rule).toMatch(/progress line/)
    expect(rule).toMatch(/also when they put something off/)
    expect(rule).toContain('알겠어요, 지금은 여기까지 할게요.')
  })

  it('asks for first and second person voice and forbids third-person narration about the person', () => {
    expect(rule).toContain('first person, never about them in the third person')
    expect(rule).toMatch(/never about them in the third person/)
    expect(rule).toContain('사용자가 … 물어봤으니')
    expect(rule).toContain('The user said')
  })

  it('keeps one voice rule rather than a second overlapping one', () => {
    expect(openRuleLines().filter((line) => /third person/.test(line))).toHaveLength(1)
  })
})
