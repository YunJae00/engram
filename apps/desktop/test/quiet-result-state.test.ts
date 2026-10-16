import { expect, it } from 'vitest'
import type { TurnStep } from 'core'
import { checkResult } from '../src/main/result-check.js'
import { freshResultReadback, needsResultCheck } from '../src/main/task-result-state.js'
import { workLabel } from '../src/renderer/src/lib/pendingStatus.js'

const step = (tool: string, observation = 'Current app state'): TurnStep => ({ tool, args: {}, observation })

it.each(['app_set', 'app_press', 'app_do'])('checks %s and requires a subsequent app read', tool => {
  expect(needsResultCheck('Done', [step(tool)])).toBe(true)
  expect(freshResultReadback([step('app_text'), step(tool)])).toBe(false)
  expect(freshResultReadback([step(tool), step('app_text')])).toBe(true)
  expect(freshResultReadback([step(tool), step('app_read')])).toBe(true)
  expect(workLabel(`${tool}: app`)).toBe('Working with an app')
})

it('accepts app reads as source evidence and rejects changes after the final check', () => {
  const finding = { status: 'pass', basis: 'The app shows the requested result.' }
  const report = step('report_result_check', JSON.stringify({ resultCheck: { checks: [{ ...finding, requirement: 'Read the app' }], grounding: finding } }))
  expect(checkResult([step('app_text'), report], [], [], true).accepted).toBe(true)
  const changed = checkResult([step('app_text'), report, step('app_press')], [], [], true)
  expect(changed.accepted).toBe(false)
  expect(changed.issues).toContain('The result changed after report_result_check. Reread the affected result and submit a new report.')
})
