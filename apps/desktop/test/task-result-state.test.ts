import { expect, it, vi } from 'vitest'
import type { AgentLoopResult, TurnStep } from 'core'
import { checkResult, resultCheckTool } from '../src/main/result-check.js'
import { canLearnTurn, freshResultReadback, holdTaskResult, needsResultCheck } from '../src/main/task-result-state.js'
import { done, pressed, readback, setup } from './task-runner-fixture.js'

const read: TurnStep = { tool: 'read_open_page', args: {}, observation: 'Current saved state' }

it('does not hide incomplete answers for an automatic continuation', () => {
  const draft = { answer: 'Same result', steps: [read] }
  const turn = { holdIf: () => false }
  expect(holdTaskResult({ ...draft, incomplete: 'The page check was not confirmed.' }, turn)).toBe(false)
  expect(holdTaskResult({ ...draft, stopped: 'calls' }, turn)).toBe(false)
  expect(holdTaskResult(draft, turn)).toBe(false)
  expect(holdTaskResult({ ...draft, asked: true, incomplete: 'Need input' }, turn)).toBe(false)
  expect(holdTaskResult({ ...draft, pending: 'run_procedure' }, turn)).toBe(false)
  expect(holdTaskResult({ ...draft, incomplete: 'No unattended task' })).toBe(false)
})
const result = (steps: TurnStep[], extra: Partial<AgentLoopResult> = {}) => ({ steps, ...extra })
const report = async (): Promise<TurnStep> => {
  const finding = { status: 'pass', basis: 'The requested state is present.' }
  const args = { checks: [{ ...finding, requirement: 'Finish the task' }], grounding: finding }
  return { tool: 'report_result_check', args, observation: await resultCheckTool().run(args, { task: 'Finish the task' }) }
}

// qa143 S19 d: an answer the runner re-checks at once waits for that re-check; anything the person must see now does not.
it('holds a finished answer only when the runner says its own re-check follows', () => {
  const draft = { answer: 'Report', steps: [read] }
  const open = { accepted: false, issues: ['Row count not read back'] }
  const holdIf = vi.fn((_answer: string, _steps: TurnStep[], check?: { accepted: boolean }) => !!check && !check.accepted)
  expect(holdTaskResult(draft, { holdIf }, open)).toBe(true)
  expect(holdIf).toHaveBeenLastCalledWith('Report', [read], open)
  expect(holdTaskResult(draft, { holdIf }, { accepted: true, issues: [] })).toBe(false)
  expect(holdTaskResult({ ...draft, incomplete: 'Not confirmed.' }, { holdIf }, open)).toBe(false)
  expect(holdTaskResult({ ...draft, stopped: 'calls' }, { holdIf }, open)).toBe(false)
  expect(holdTaskResult({ ...draft, asked: true }, { holdIf }, open)).toBe(false)
  expect(holdTaskResult(draft, { verification: { result: 'Report' } })).toBe(true)
})

it('does not learn a held draft before its verification turn', () => {
  expect(canLearnTurn(result([read]), true)).toBe(false)
  expect(canLearnTurn(result([]), false)).toBe(true)
})

it('does not learn a passing report that has no fresh readback', async () => {
  const steps = [await report()]
  const check = checkResult(steps, [], [])
  expect(check.accepted).toBe(true)
  expect(freshResultReadback(steps)).toBe(false)
  expect(canLearnTurn(result(steps), true, check)).toBe(false)
  expect(canLearnTurn(result(steps), false, check)).toBe(false)
})

it.each(['scroll', 'open_page', 'press'])('does not learn a report after a failed %s invalidates its earlier evidence', async tool => {
  const steps = [read, { tool, args: {}, observation: 'that did not work: unavailable' }, await report()]
  const check = checkResult(steps, [], [])
  expect(check.accepted).toBe(true)
  expect(freshResultReadback(steps)).toBe(false)
  expect(canLearnTurn(result(steps), true, check)).toBe(false)
  expect(canLearnTurn(result(steps), false, check)).toBe(false)
})

it('defers even an accepted held check to task completion, and validates non-held checks', async () => {
  const steps = [read, await report()]
  expect(canLearnTurn(result(steps), true, checkResult(steps, [], []))).toBe(false)
  expect(canLearnTurn(result(steps), false, checkResult(steps, [], []))).toBe(true)
  expect(canLearnTurn(result(steps), false, { accepted: false })).toBe(false)
  expect(canLearnTurn(result([{ ...read, seeded: true }]), false, { accepted: true })).toBe(false)
})

it('records verified evidence from the original turn without an extra check', async () => {
  const t = await setup(async () => ({ ...done('Confirmed final result', 3), trail: [pressed('Save'), ...readback('').trail!], check: { accepted: true, issues: [] } }))
  await t.chat('Save the requested fields')
  expect((await t.settle('done')).verified).toBe(true)
  expect(t.sent).toHaveLength(1)
  await vi.waitFor(() => expect(t.remembered).toHaveLength(1))
  expect(t.remembered[0]).toContain('Confirmed final result')
})

it.each<Partial<AgentLoopResult>>([{ asked: true }, { stopped: 'calls' }, { pending: 'run_procedure' }, { incomplete: 'More work remains' }])('does not learn an unfinished turn %j', extra => {
  expect(canLearnTurn(result([read], extra), false)).toBe(false)
  expect(canLearnTurn(result([read], extra), true, { accepted: true })).toBe(false)
})

it('checks a result only when something was saved, committed or changed, not after reading a site', () => {
  const look = [{ tool: 'open_page', args: { url: 'https://tms.example' }, observation: 'opened' }, pressed('Time Report', false), { tool: 'choose', args: { target: 'Project', option: 'ChatX' }, observation: 'chosen' }, read]
  expect(needsResultCheck('Last week: 58 hours.', look)).toBe(false)
  expect(needsResultCheck('Last week: 58 hours.', [...look, pressed('Save')])).toBe(true)
  expect(needsResultCheck('Last week: 58 hours.', [...look, { tool: 'page_steps', args: {}, observation: 'Done in order: press "Save".', committed: true }])).toBe(true)
  expect(needsResultCheck('Partially saved', [{ tool: 'page_steps', args: {}, observation: 'that did not work: Save succeeded, Next failed', committed: true }])).toBe(true)
  expect(needsResultCheck('Last week: 58 hours.', [...look, { tool: 'page_steps', args: {}, observation: 'Done in order: press "Next".' }])).toBe(false)
  expect(needsResultCheck('Saved [Report](engram-artifact:report.md)', look)).toBe(true)
  expect(needsResultCheck('Done', [{ tool: 'excel_write', args: {}, observation: 'written' }])).toBe(true)
  expect(needsResultCheck('Done', [{ ...pressed('Save'), observation: 'that did not work: no such control' }])).toBe(false)
})
