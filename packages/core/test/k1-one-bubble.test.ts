import { describe, expect, it } from 'vitest'
import { openRuleLines, type TurnKind } from '../src/agent-prompt.js'
import { sessionRules } from '../src/agent-session-shape.js'

const KINDS: TurnKind[] = ['short', 'lookup', 'work']
const FLAGS = { engineId: 'mock', desktop: false, workflow: false, browser: false, planned: false, pageSteps: false }

describe('the model is told that a blank line is a bubble break, in every kind of turn', () => {
  it.each(KINDS)('a %s turn asks for one bubble with the body right under the lead', kind => {
    const rules = openRuleLines({ kind }).join('\n')
    expect(rules).toContain('A blank line is never spacing: it starts a new message bubble. Write the reply as ONE bubble with no blank line: the lead, then the table or list on the next line, nothing after it.')
    expect(rules).toContain('Only a second table or list gets a second bubble: not one per item, teammate or paragraph, no dash lines.')
  })

  it('no rule asks for several messages or for a blank line as a separator', () => {
    const told = [...KINDS.map(kind => openRuleLines({ kind }).join('\n')), ...KINDS.map(kind => sessionRules({ ...FLAGS, kind }))].join('\n')
    expect(told).not.toMatch(/two to four short messages|use one between the result line and its details|at most three bubbles/)
    expect(sessionRules({ ...FLAGS, kind: 'work' })).toContain('reply as one message with no blank line in it')
  })
})
