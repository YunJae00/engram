import { expect, it, vi } from 'vitest'
import type { AgentLoopResult, TurnStep } from 'core'
import { checkResult, resultCheckTool } from '../src/main/result-check.js'
import { canLearnTurn, freshResultReadback } from '../src/main/task-result-state.js'
import { done, pressed, readback, setup } from './task-runner-fixture.js'

const read: TurnStep = { tool: 'read_open_page', args: {}, observation: 'Current saved state' }
const result = (steps: TurnStep[], extra: Partial<AgentLoopResult> = {}) => ({ steps, ...extra })
const report = async (): Promise<TurnStep> => {
  const finding = { status: 'pass', basis: 'The requested state is present.' }
  const args = { checks: [{ ...finding, requirement: 'Finish the task' }], grounding: finding }
  return { tool: 'report_result_check', args, observation: await resultCheckTool().run(args, { task: 'Finish the task' }) }
}

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

it('still records verified task memory after the runner confirms completion', async () => {
  const t = await setup(async (_request, turn) => turn === 1
    ? { ...done('Draft', 3), trail: [pressed('Save')] }
    : readback('Confirmed final result'))
  await t.chat('Save the requested fields')
  expect((await t.settle('done')).verified).toBe(true)
  await vi.waitFor(() => expect(t.remembered).toHaveLength(1))
  expect(t.remembered[0]).toContain('Confirmed final result')
  expect(t.remembered[0]).not.toContain('Draft')
})

it.each<Partial<AgentLoopResult>>([{ asked: true }, { stopped: 'calls' }, { pending: 'run_procedure' }, { incomplete: 'More work remains' }])('does not learn an unfinished turn %j', extra => {
  expect(canLearnTurn(result([read], extra), false)).toBe(false)
  expect(canLearnTurn(result([read], extra), true, { accepted: true })).toBe(false)
})
