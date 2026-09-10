import { expect, it } from 'vitest'
import type { AgentLoopStep } from '../src/agent-loop.js'
import { taskPlan } from '../src/agent-plan.js'

const context = { task: 'Prepare, update and verify the requested document without saving it' }
function observe(steps: AgentLoopStep[], text: string): number {
  steps.push({ tool: 'read_desktop', args: {}, observation: text })
  return steps.length
}

it('replans unfinished outcomes from new evidence without replaying completed phases or earning calls', async () => {
  const steps: AgentLoopStep[] = []
  const plan = taskPlan(steps)
  await plan.tool.run({ phases: ['Prepare a new document', 'Update and verify the requested contents'] }, context)
  await plan.tool.run({ evidenceStep: observe(steps, 'New empty document visible'), finding: 'New document ready' }, context)
  const evidenceStep = observe(steps, 'Requested contents exist but the displayed total has not refreshed')
  const result = JSON.parse(await plan.tool.run({
    remainingPhases: ['Refresh and verify the existing values without repeating input', 'Verify formatting without saving'],
    evidenceStep, finding: 'The contents are already present; only recalculation and formatting remain',
  }, context))
  expect(result).toMatchObject({ completed: 1, total: 3, current: 'Refresh and verify the existing values without repeating input' })
  expect(plan.completed()).toBe(1)
  expect(plan.pending()).toContain('2/3')
  await expect(plan.tool.run({ evidenceStep, finding: 'Done' }, context)).rejects.toThrow()
  await plan.tool.run({ evidenceStep: observe(steps, 'Requested totals match'), finding: 'Totals confirmed' }, context)
  expect(plan.pending()).toContain('Verify formatting without saving')
  await plan.tool.run({ evidenceStep: observe(steps, 'Requested formatting visible'), finding: 'Formatting confirmed' }, context)
  expect(plan.pending()).toBeUndefined()
})

it('refuses stale evidence, empty or oversized revisions and extra arguments without changing the plan', async () => {
  const steps: AgentLoopStep[] = []
  const plan = taskPlan(steps)
  await plan.tool.run({ phases: ['Prepare', 'Verify'] }, context)
  await plan.tool.run({ evidenceStep: observe(steps, 'Ready'), finding: 'Ready' }, context)
  const evidenceStep = observe(steps, 'Unexpected review view')
  for (const remainingPhases of [[], [' '], ['x'.repeat(241)], Array(8).fill('Next'), [1]]) {
    await expect(plan.tool.run({ remainingPhases, evidenceStep, finding: 'Changed view' }, context)).rejects.toThrow()
  }
  await expect(plan.tool.run({ remainingPhases: ['Next'], evidenceStep: evidenceStep - 1, finding: 'Old view' }, context)).rejects.toThrow()
  await expect(plan.tool.run({ remainingPhases: ['Next'], evidenceStep, finding: 'Changed view', approved: true }, context)).rejects.toThrow()
  expect(plan.completed()).toBe(1)
  expect(plan.pending()).toContain('Verify')
})

it('cannot replan an absent or finished plan, from failed input, or after cancellation', async () => {
  const steps: AgentLoopStep[] = []
  const plan = taskPlan(steps)
  const revision = () => ({ remainingPhases: ['Next'], evidenceStep: steps.length, finding: 'Changed view' })
  observe(steps, 'Ready')
  await expect(plan.tool.run(revision(), context)).rejects.toThrow()
  await plan.tool.run({ phases: ['Prepare', 'Verify'] }, context)
  steps.push({ tool: 'desktop_sequence', args: {}, observation: JSON.stringify({ error: 'Stopped', observationMayBeStale: true, observation: { snapshot: 'old' } }) })
  await expect(plan.tool.run(revision(), context)).rejects.toThrow()
  observe(steps, 'Fresh view')
  await expect(plan.tool.run(revision(), { ...context, signal: AbortSignal.abort() })).rejects.toThrow()
  expect(plan.completed()).toBe(0)
  await plan.tool.run({ evidenceStep: steps.length, finding: 'Prepared' }, context)
  await plan.tool.run({ evidenceStep: observe(steps, 'Verified'), finding: 'Done' }, context)
  observe(steps, 'Still verified')
  await expect(plan.tool.run(revision(), context)).rejects.toThrow()
  expect(plan.completed()).toBe(2)
})

it('uses fresh failure readback to revise, but never treats that failure as completion', async () => {
  const steps: AgentLoopStep[] = []
  const plan = taskPlan(steps)
  await plan.tool.run({ phases: ['Prepare', 'Verify'] }, context)
  steps.push({ tool: 'desktop_sequence', args: {}, observation: JSON.stringify({ error: 'Value did not match', observationMayBeStale: false, observation: { snapshot: 'current', value: 'pending' } }) })
  await expect(plan.tool.run({ evidenceStep: 1, finding: 'Done' }, context)).rejects.toThrow()
  await plan.tool.run({ remainingPhases: ['Inspect the pending value', 'Complete and verify'], evidenceStep: 1, finding: 'The fresh view shows a pending value rather than the requested result' }, context)
  expect(plan.completed()).toBe(0)
  expect(plan.pending()).toContain('Inspect the pending value')
})
