import { describe, expect, it } from 'vitest'
import { DESKTOP_TASK_RULE, wrapUpPrompt } from '../src/agent-prompt.js'

describe('desktop wrap-up guidance', () => {
  it('asks for 했어/못 했어 and never success while moving', () => {
    for (const part of ['했어', '못 했어', 'outcome.stillMoving', 'the field text differs', 'unless the person asked to send']) expect(DESKTOP_TASK_RULE).toContain(part)
    expect(wrapUpPrompt('x', [])).toContain('outcome.done is false')
  })
})
