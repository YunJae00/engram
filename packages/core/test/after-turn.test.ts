import { expect, it } from 'vitest'
import { openRuleLines } from './rules.js'

it('instructs the engine to complete and verify work within the same turn', () => {
  const rules = openRuleLines().join('\n')
  expect(rules).toContain('Finish the job this turn and check each claim against what you read')
  expect(rules).toContain('never end on a plan to try something: try it now')
  expect(rules).toContain('call ask_person and wait')
  expect(rules).toContain('repeat a side effect')
})
