import { expect, it } from 'vitest'
import { openRuleLines } from '../src/agent-prompt.js'

it('instructs the engine to complete and verify work within the same turn', () => {
  const rules = openRuleLines().join('\n')
  expect(rules).toContain('Persist through execution and verification within the current turn')
  expect(rules).toContain('do not stop at analysis, a plan, or a partial change')
  expect(rules).toContain('call ask_person and wait')
  expect(rules).toContain('repeat completed side effects')
})
