import { expect, it } from 'vitest'
import { openRuleLines } from './rules.js'

it('instructs the engine to finish from evidence and verify unsettled claims', () => {
  const rules = openRuleLines().join('\n')
  expect(rules).toContain('Finish this turn and answer from observed evidence; verify only unsettled claims')
  expect(rules).toContain('Never end on a plan: try it now')
  expect(rules).toContain('call ask_person and wait')
  expect(rules).toContain('repeat a side effect')
})
