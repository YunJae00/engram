import { describe, expect, it } from 'vitest'
import { sessionRules } from '../src/agent-session-shape.js'
import { openRuleLines, PRIOR_CLAIM_RULE, skillIndexLines, stepPrompt, wrapUpPrompt } from '../src/agent-prompt.js'

describe('a comet claims the person did something before only after reading it this turn', () => {
  it('the open rules tie any claim about earlier requests, records or work to a search or read this turn', () => {
    expect(openRuleLines()).toContain(PRIOR_CLAIM_RULE)
    expect(PRIOR_CLAIM_RULE).toMatch(/asked for, did or saved something before/)
    expect(PRIOR_CLAIM_RULE).toMatch(/a search or read this turn/)
    expect(PRIOR_CLAIM_RULE).toContain('search_chats')
    expect(PRIOR_CLAIM_RULE).toContain('이전에 같은 요청을 하신 기록이 있네요')
    expect(PRIOR_CLAIM_RULE).toContain('메모와 대화 기록을 확인해볼게요.')
    expect(PRIOR_CLAIM_RULE).toMatch(/nothing earlier was found, say so/)
  })

  it('an empty skill index does not call the task recurring', () => {
    const lines = skillIndexLines([]).join('\n')
    expect(lines).toContain('find_skills')
    expect(lines).not.toMatch(/recurring/)
  })

  it('reaches guided first-turn, guided wrap-up, open and tool-session prompts alike', () => {
    const prompts = [
      stepPrompt('회의록 정리해줘', [], []),
      wrapUpPrompt('회의록 정리해줘', []),
      stepPrompt('organise meeting notes', [], [], undefined, undefined, undefined, false),
      wrapUpPrompt('organise meeting notes', [], undefined, undefined, undefined, false),
    ]
    prompts.push(sessionRules({ engineId: 'claude', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false }))
    for (const prompt of prompts) expect(prompt).toContain(PRIOR_CLAIM_RULE)
  })
})
