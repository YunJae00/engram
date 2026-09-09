import { expect, it } from 'vitest'
import { taskPlan } from '../src/agent-plan.js'
import type { AgentLoopStep } from '../src/agent-loop.js'

it('tracks model-selected outcomes and accepts only fresh observation checkpoints', async () => {
  const steps: AgentLoopStep[] = []
  const plan = taskPlan(steps)
  await plan.tool.run({ phases: ['Prepare the requested workspace', 'Perform and verify the requested changes'] }, { task: 'Work on the selected document' })
  expect(plan.pending()).toContain('1/2')
  steps.push({ tool: 'desktop_action', args: {}, observation: 'input sent' })
  await expect(plan.tool.run({ evidenceStep: 1, finding: 'Ready' }, { task: '' })).rejects.toThrow('fresh result')
  steps.push({ tool: 'read_desktop', args: {}, observation: 'Empty requested workspace visible' })
  await plan.tool.run({ evidenceStep: 2, finding: 'The workspace is ready' }, { task: '' })
  expect(plan.completed()).toBe(1)
  await expect(plan.tool.run({ evidenceStep: 2, finding: 'Reuse' }, { task: '' })).rejects.toThrow()
  steps.push({ tool: 'read_desktop', args: {}, observation: 'that did not work: connection lost' })
  await expect(plan.tool.run({ evidenceStep: 3, finding: 'Done' }, { task: '' })).rejects.toThrow()
  expect(plan.pending()).toContain('2/2')
  steps.push({ tool: 'look_desktop', args: {}, observation: 'Requested final content visible' })
  await plan.tool.run({ evidenceStep: 4, finding: 'All requested content matches' }, { task: '' })
  expect(plan.pending()).toBeUndefined()
  await expect(plan.tool.run({ phases: ['Reset', 'Budget'] }, { task: '' })).rejects.toThrow()
})

it('rejects malformed plans and honours cancellation before changing state', async () => {
  const plan = taskPlan([])
  for (const phases of [[], ['Only one'], [' ', 'Next'], Array(9).fill('Step'), [1, 2]]) {
    await expect(plan.tool.run({ phases }, { task: '' })).rejects.toThrow()
  }
  await expect(plan.tool.run({ phases: ['Prepare', 'Verify'] }, { task: '', signal: AbortSignal.abort() })).rejects.toThrow()
  expect(plan.pending()).toBeUndefined()
})

it('reuses action readback evidence but refuses stale or failed batch results', async () => {
  const steps: AgentLoopStep[] = []
  const plan = taskPlan(steps)
  await plan.tool.run({ phases: ['Prepare', 'Verify'] }, { task: '' })
  steps.push({ tool: 'desktop_action', args: {}, observation: JSON.stringify({ dispatched: true, observation: { snapshot: 'fresh' } }) })
  await plan.tool.run({ evidenceStep: 1, finding: 'Target state confirmed' }, { task: '' })
  steps.push({ tool: 'desktop_sequence', args: {}, observation: JSON.stringify({ observationMayBeStale: true, observation: { snapshot: 'old' } }) })
  await expect(plan.tool.run({ evidenceStep: 2, finding: 'Done' }, { task: '' })).rejects.toThrow()
  expect(plan.completed()).toBe(1)
})
