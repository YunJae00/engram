import { describe, expect, it } from 'vitest'
import { REFERENCE_ID_RULE, openRuleLines, stepPrompt, wrapUpPrompt } from '../src/agent-prompt.js'
import { sessionRules } from '../src/agent-session-shape.js'

const task = '다음주 화요일 거래처 미팅 준비 메모: 견적서 v2 들고 가기, 토큰 CLI-4402'
const count = (prompt: string) => prompt.split(REFERENCE_ID_RULE).length - 1

describe('reference identifiers are not action items', () => {
  it('has one standing rule that keeps an identifier as a reference', () => {
    const lines = openRuleLines().filter((line) => /identifier/.test(line) && /CLI-4402/.test(line))
    expect(lines).toEqual([REFERENCE_ID_RULE])
    const [rule] = lines
    for (const pattern of [/token/, /ticket/, /reference/, /never make it into its own/i, /owner/, /due date/])
      expect(rule).toMatch(pattern)
    expect(rule).toContain('견적서 v2 들고 가기')
  })

  it('reaches guided step and wrap-up prompts once', () => {
    expect(count(stepPrompt(task, [], []))).toBe(1)
    expect(count(wrapUpPrompt(task, []))).toBe(1)
  })

  it('reaches the unguided step prompt once', () => {
    expect(count(stepPrompt(task, [], [], undefined, undefined, undefined, false))).toBe(1)
  })

  it('reaches native session rules', () => {
    const rules = sessionRules({ engineId: 'claude', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false })
    expect(rules).toContain(REFERENCE_ID_RULE)
  })
})
