import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { cometRecord, continuationPrompt, createTask, listTasks, logTask, tasksToResume, updateTask } from '../src/delegated-tasks.js'
import type { VaultPaths } from '../src/vault.js'

async function tempPaths(): Promise<VaultPaths> {
  const root = await mkdtemp(join(tmpdir(), 'engram-tasks-'))
  return { root, workspace: root, cache: join(root, '.engram') } as unknown as VaultPaths
}

it('keeps delegated tasks on disk through concurrent changes and bounds their log', async () => {
  const paths = await tempPaths()
  const [a, b] = await Promise.all([createTask(paths, '  Reconcile the September invoices  ', 'bot-a'), createTask(paths, 'Draft the weekly report', 'bot-b')])
  expect(a.goal).toBe('Reconcile the September invoices')
  await Promise.all([
    updateTask(paths, a.id, (t) => { t.state = 'running'; for (let i = 0; i < 80; i++) logTask(t, `step ${i}`) }),
    updateTask(paths, b.id, (t) => { t.state = 'done' }),
  ])
  const tasks = await listTasks(paths)
  expect(tasks.map((t) => t.state).sort()).toEqual(['done', 'running'])
  expect(tasks.find((t) => t.id === a.id)!.log).toHaveLength(60)
  expect(tasks.find((t) => t.id === b.id)!.finishedAt).toBeTruthy()
  expect(JSON.parse(await readFile(join(paths.cache, 'tasks.json'), 'utf8')).tasks).toHaveLength(2)
  expect(tasksToResume(tasks).map((t) => t.id)).toEqual([a.id])
  await expect(createTask(paths, '   ', 'bot-c')).rejects.toThrow('Say what the task is')
})

it('continues with the goal verbatim and says why', async () => {
  const paths = await tempPaths()
  const task = await createTask(paths, 'File the expense report\nKeep receipts attached.', 'bot-a')
  const restart = continuationPrompt(task, 'restart')
  expect(restart).toContain('The app restarted')
  expect(restart.endsWith('The delegated task, verbatim:\nFile the expense report\nKeep receipts attached.')).toBe(true)
  expect(continuationPrompt(task, 'answer', 'Their answer: use the team card')).toContain('Their answer: use the team card')
  task.verificationIssue = 'The output has an unsupported claim.'
  const verify = continuationPrompt(task, 'verify')
  expect(verify).toContain('report_result_check')
  expect(verify).toContain('its outputs, terms and rules count as part of the request')
  expect(verify).toContain('Do not promote optional inspection methods or extra workflows into new requirements')
  expect(verify).toContain('original sources and user request, not your own outputs')
  expect(verify).toContain('Previous check did not pass: The output has an unsupported claim.')
  expect(continuationPrompt({ ...task, result: '[Report](engram-artifact:report.md)' }, 'verify')).toContain('Check this result and correct only what is wrong; do not redo the task:\n[Report](engram-artifact:report.md)')
  expect(continuationPrompt({ ...task, result: 'draft' }, 'limit')).not.toContain('draft')
  expect(verify).toContain('do not keep adding exploratory checks')
})

it('counts how often a comet\'s checked work was confirmed, leaving unchecked tasks out', async () => {
  const paths = await tempPaths()
  const mine = await createTask(paths, 'Report', 'bot-1')
  const unconfirmed = await createTask(paths, 'Sheet', 'bot-1')
  await createTask(paths, 'Question', 'bot-1')
  const theirs = await createTask(paths, 'Other', 'bot-2')
  await updateTask(paths, mine.id, task => { task.verified = true })
  await updateTask(paths, unconfirmed.id, task => { task.verificationIssue = 'The check ran out of time.' })
  await updateTask(paths, theirs.id, task => { task.verified = true })
  expect(cometRecord(await listTasks(paths), 'bot-1')).toEqual({ confirmed: 1, checked: 2 })
  expect(cometRecord(await listTasks(paths), 'bot-3')).toEqual({ confirmed: 0, checked: 0 })
})
