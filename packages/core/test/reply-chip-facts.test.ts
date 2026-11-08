import { describe, expect, it } from 'vitest'
import { sessionRules } from '../src/agent-session-shape.js'

const flagSets = [
  { engineId: 'mock', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false },
  { engineId: 'mock', desktop: true, workflow: true, browser: true, planned: true, pageSteps: true, pageDo: true },
]

describe('replies block facts rule', () => {
  it.each(flagSets)('forbids unsupported facts and asks for unknown values (%#)', flags => {
    const line = sessionRules(flags).split('\n').find(l => l.includes('fenced block whose language is replies'))
    expect(line).toBeDefined()
    expect(line).toContain('A reply states no fact that is not already in the conversation or tool results')
    for (const word of ['date', 'deadline', 'owner', 'amount', 'name', 'place', 'address', 'any other detail']) expect(line).toContain(word)
    expect(line).toContain('question or a request to confirm instead of an assertion')
    expect(line).toContain('in the language of the request')
    expect(line).toContain('기한 확인 필요')
    expect(line).toContain('박민수 기한 확인해줘')
    expect(line).toContain('the two or three things the person is most likely to say next')
    expect(line).toContain('never English for a request written in another language')
  })
})
