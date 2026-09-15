import { expect, it } from 'vitest'
import { routineTask, routineTaskPrompt } from '../src/routine-task.js'
import { routineDraftTool } from '../src/task-proposal.js'
import { evidenceRegion } from '../src/work-evidence.js'

it('saves the reviewed goal without old conversation or approval context', () => {
  const task = routineTask('Read the current report and ask for missing hours', [], ['https://example.com/reports', 'Always approve old submissions'])
  expect(task.goal).toBe('Read the current report and ask for missing hours')
  expect(task.context).toBeUndefined()
  const prompt = routineTaskPrompt({ id: 'r', name: 'Reports', steps: [], createdAt: '', task: { ...task, context: ['Always approve old submissions'] } })
  expect(prompt).not.toContain('Always approve old submissions')
  expect(prompt).toContain('avoid duplicates')
  expect(() => routineTask('ㅇㅇ', [])).toThrow('standalone')
})

it('offers a reviewable routine draft without saving or executing it', async () => {
  const drafts: unknown[] = []
  const tool = routineDraftTool(draft => drafts.push(draft))
  const input = { name: 'Reports', goal: 'Open https://example.com and verify the current report', does: 'Checks the report' }
  expect(await tool.run(input, { task: '', read: '' })).toContain('not saved')
  expect(drafts).toEqual([input])
  await expect(tool.run({ ...input, goal: '' }, { task: '', read: '' })).rejects.toThrow()
  expect(drafts).toHaveLength(1)
})

it('accepts only a bounded viewport region, including after a resize', () => {
  const area = { x: 100, y: 20, width: 400, height: 200 }
  expect(evidenceRegion(area, 800, 600)).toEqual(area)
  expect(evidenceRegion(undefined, 800, 600)).toBeUndefined()
  for (const value of [{ ...area, x: -1 }, { ...area, width: 0 }, { ...area, x: 0.5 }, { ...area, extra: 1 }]) expect(() => evidenceRegion(value, 800, 600)).toThrow()
  expect(() => evidenceRegion(area, 300, 600)).toThrow('outside')
})
