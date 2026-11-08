import { describe, expect, it } from 'vitest'
import { openRuleLines } from '../src/agent-prompt.js'

describe('a comet answers a hold in its own voice', () => {
  const rule = openRuleLines().find((line) => line.startsWith('Speak to the person directly'))

  it('applies the direct-voice rule to every reply, final answers and hold acknowledgements included', () => {
    expect(rule).toBeDefined()
    expect(rule).toMatch(/every reply/)
    expect(rule).toMatch(/final answer/)
    expect(rule).toMatch(/put something off or hold it/)
    expect(rule).toContain('알겠어요, 지금은 여기까지 할게요.')
  })

  it('asks for first and second person voice and forbids third-person narration about the person', () => {
    expect(rule).toMatch(/in the first person, addressing them in the second person/)
    expect(rule).toMatch(/never about them in the third person/)
    expect(rule).toContain('사용자가 나중에 하겠다고 했으니')
    expect(rule).toContain('The user said')
  })

  it('keeps one voice rule rather than a second overlapping one', () => {
    expect(openRuleLines().filter((line) => /third person/.test(line))).toHaveLength(1)
  })
})
