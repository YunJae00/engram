import { expect, it, vi } from 'vitest'
import { createTask, findPlaybook, listTasks, TASK_MAX_TURNS, updateTask } from 'core'
import type { TurnOutcome } from '../src/main/task-runner.js'
import { done, setup, pressed, readback } from './task-runner-fixture.js'

it('does not add a check turn to an answer that changed nothing', async () => {
  const t = await setup(async () => ({ ...done('Read three pages', 3), trail: [{ tool: 'open_page', args: { url: 'https://docs.example' }, observation: 'opened' }, { tool: 'press', args: { target: 'Submit' }, observation: '"Submit" was not pressed: it waits' }] }))
  await t.chat('Summarize the docs')
  expect((await t.settle('done')).turns).toBe(1)
})

it('starts a similar request from where it began last time and the steps that worked, and counts how often', async () => {
  const t = await setup(async () => ({ ...done('Filed', 4), trail: [
    { tool: 'open_page', args: { url: 'https://expenses.example/new' }, observation: 'opened' },
    { tool: 'type_text', args: { target: 'Amount' }, observation: 'typed' },
    pressed('Attach receipt'),
    pressed('Submit'),
  ] }))
  await t.chat('File the taxi receipt as an expense')
  await t.settle('done')
  expect(t.sent[0]!.extra?.context).toBeUndefined()
  await vi.waitFor(async () => expect(await findPlaybook(t.paths, 'File the hotel receipt as an expense')).toBeDefined())
  await t.chat('File the hotel receipt as an expense')
  await vi.waitFor(async () => expect((await listTasks(t.paths)).map(x => x.state)).toEqual(['done', 'done']))
  const context = t.sent[1]!.extra?.context ?? ''
  expect(context).toContain('A similar task was finished')
  expect(context).toContain('Started from: https://expenses.example/new')
  expect(context).toContain('- press: Submit')
  expect(t.sent[1]!.request.message).toBe('File the hotel receipt as an expense')
  await vi.waitFor(async () => expect((await findPlaybook(t.paths, 'File the train receipt as an expense'))?.count).toBe(2))
  await t.chat('File the train receipt as an expense')
  await vi.waitFor(async () => expect((await listTasks(t.paths)).map(x => x.state)).toEqual(['done', 'done', 'done']))
  const detailed = t.sent[2]!.extra?.context ?? ''
  expect(detailed).toContain('finished 2 times')
  expect(detailed).toContain('- press: Submit')
})

it('restores a pending check from disk without running it before the person resumes', async () => {
  const t = await setup(async () => readback('Verified after restart'))
  const task = await createTask(t.paths, 'Check saved supplier', 'bot-1')
  await updateTask(t.paths, task.id, x => { x.state = 'running'; x.turns = 1; x.verificationPending = true; x.result = 'Saved supplier' })
  await t.runner.resume()
  expect(t.sent).toHaveLength(0)
  await t.chat('Continue after checking the current state')
  expect((await t.settle('done')).verificationPending).toBeUndefined()
  expect(t.sent[0]!.extra?.verification).toBeUndefined()
})

it('leaves unfinished work waiting without automatically restarting the model', async () => {
  const t = await setup(async () => ({ ...done('Half done', 4), unfinished: true }))
  await t.chat('Reconcile the invoices')
  const task = await t.settle('waiting')
  expect(task.turns).toBe(1)
  expect(task.result).toBe('Half done')
  expect(t.sent).toHaveLength(1)
  expect(t.remembered).toEqual([])
})

it('keeps a quick answer out of the notes, and takes the next message as the answer to a question', async () => {
  const t = await setup(async (_r, turn) => turn === 1 ? done('Paris') : turn === 2 ? { answer: 'Which quarter?', asked: true, unfinished: false, steps: 1 } : done('Sent the Q3 draft', 5))
  await t.chat('Capital of France?')
  await t.settle('done')
  expect(t.remembered).toEqual([])
  await t.chat('Prepare the quarterly numbers')
  expect((await t.settle('waiting')).question).toBe('Which quarter?')
  await t.chat('Calendar Q3')
  const task = await t.settle('done')
  expect(task.goal).toBe('Prepare the quarterly numbers')
  expect(t.sent[2]!.request.message).toBe('Calendar Q3')
  expect(t.sent[2]!.extra?.context).toContain('The task, verbatim:\nPrepare the quarterly numbers')
  expect(t.learned).toEqual([['Which quarter?', 'Calendar Q3']])
  expect((await listTasks(t.paths)).map((x) => x.state)).toEqual(['done', 'done'])
})

it('lets a card be answered while the turn runs, for a call that waits on it', async () => {
  const t = await setup(async (request, _turn, _extra, runner) => {
    const ask = runner.askFor(request.channel!, async () => 'approve', 5000)!
    return done(`commands: ${await ask({ words: 'Run commands in this comet\'s work folder', url: 'file:///C:/work' })}`)
  })
  const running = t.chat('Summarise the workbook')
  const waiting = await vi.waitFor(async () => {
    const task = (await listTasks(t.paths)).at(-1)!
    expect(task?.approvals).toHaveLength(1)
    return task
  }, { timeout: 5000 })
  await t.call('tasks:decide', waiting.id, waiting.approvals[0]!.id, 'approve')
  await running
  const task = await t.settle('done')
  expect(task.result).toBe('commands: approve')
  expect(task.approvals.map((a) => [a.answer, a.settled])).toEqual([['approve', true]])
  expect(t.sent).toHaveLength(1)
})

it('leaves committing presses for the person, one per page, and makes exactly the approved ones', async () => {
  const verdicts: string[] = []
  const t = await setup(async (request, turn, _extra, runner) => {
    const ask = runner.askFor(request.channel!, async () => 'approve', 0)!
    for (const n of [1, 2]) verdicts.push(await ask({ words: 'Place on hold', url: `https://portal.example/invoices/${n}` }))
    return done(turn === 1 ? 'Everything else done' : 'Hold placed', 6)
  })
  await t.chat('Hold the duplicate invoices')
  const waiting = await t.settle('waiting')
  expect(waiting.approvals.map((a) => a.url)).toEqual(['https://portal.example/invoices/1', 'https://portal.example/invoices/2'])
  await t.call('tasks:decide', waiting.id, waiting.approvals[0]!.id, 'approve')
  await t.call('tasks:decide', waiting.id, waiting.approvals[1]!.id, 'decline')
  await t.settle('done')
  expect(verdicts).toEqual(['later', 'later', 'approve', 'cancel'])
  expect(t.sent[1]!.request.message).toContain('Approved: "Place on hold" on portal.example (https://portal.example/invoices/1)')
})

it('refuses a second message while the work runs, stops on request, and pauses interrupted work after a restart', async () => {
  let release!: () => void
  const t = await setup((_r, turn) => turn === 1 ? new Promise<TurnOutcome>((resolve) => { release = () => resolve(done('late')) }) : Promise.resolve(done('Resumed and finished')))
  const first = t.chat('Long job')
  await t.settle('running')
  await expect(t.chat('Another thing')).rejects.toThrow('still working')
  await t.runner.stopChannel('bot-bot-1')
  release()
  await first
  expect((await t.settle('stopped')).result).toBeUndefined()
  const task = await createTask(t.paths, 'Tidy the shared drive', 'bot-z')
  await updateTask(t.paths, task.id, (x) => { x.state = 'running'; x.turns = 1 })
  await t.runner.resume()
  expect((await listTasks(t.paths)).find((x) => x.id === task.id)!.state).toBe('waiting')
  expect(t.sent).toHaveLength(1)
})

it('claims a channel before disk awaits and does not dispatch after an early Stop', async () => {
  const t = await setup(async () => done('Unexpected'))
  const first = t.chat('One job')
  await expect(t.chat('Two jobs')).rejects.toThrow('still working')
  await t.runner.stopChannel('bot-bot-1')
  await first
  expect(t.sent).toHaveLength(0)
  expect((await listTasks(t.paths))[0]!.state).toBe('stopped')
})

it('marks a rejected first send failed so the conversation is not stuck running', async () => {
  const t = await setup(async () => { throw new Error('Provider unavailable') })
  await expect(t.chat('One job')).rejects.toThrow('Provider unavailable')
  expect((await listTasks(t.paths))[0]!.state).toBe('failed')
  await expect(t.chat('Try a different job')).rejects.toThrow('Provider unavailable')
  expect(await listTasks(t.paths)).toHaveLength(2)
})

it('consumes duplicate decisions once and reconfirms a deferred action on the live page', async () => {
  const confirm = vi.fn(async () => 'cancel' as const)
  const verdicts: string[] = []
  const t = await setup(async (request, _turn, _extra, runner) => {
    verdicts.push(await runner.askFor(request.channel!, confirm, 0)!({ words: 'Send', url: 'https://example.test/draft' }))
    return done('Draft prepared', 1)
  })
  await t.chat('Prepare a draft')
  const waiting = await t.settle('waiting')
  await Promise.all([1, 2, 3].map(() => t.call('tasks:decide', waiting.id, waiting.approvals[0]!.id, 'approve')))
  await t.settle('done')
  expect(t.sent).toHaveLength(2)
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(verdicts).toEqual(['later', 'cancel'])
})

it('does not exceed the call ceiling when continuing after a question', async () => {
  const t = await setup(async () => done('Unexpected'))
  const task = await createTask(t.paths, 'Long job', 'bot-1')
  await updateTask(t.paths, task.id, x => { x.state = 'waiting'; x.question = 'Continue?'; x.turns = TASK_MAX_TURNS })
  await t.chat('Continue')
  expect(t.sent).toHaveLength(0)
  expect((await listTasks(t.paths))[0]!.state).toBe('failed')
})

it('stops where a turn offered another way, instead of carrying on beside the card', async () => {
  const t = await setup(async () => ({ ...done('PageOne에서 연차 화면을 찾지 못했어요.', 4), unfinished: true }), true, undefined, channel => channel === 'bot-bot-1')
  await t.chat('Workday에서 연차 확인해줘')
  const task = await t.settle('done')
  expect(task.turns).toBe(1)
  expect(t.sent).toHaveLength(1)
  expect(task.log.at(-1)?.line).toContain('another way offered')
  expect(t.remembered).toEqual([])
})

it('keeps a running approval card past two minutes and resumes the same turn', async () => {
  let settled = false
  const t = await setup(async (request, _turn, _extra, runner) => {
    const result = await runner.askFor(request.channel!, async () => 'approve')!({ words: 'Send', url: 'https://example.test/draft' })
    settled = true
    return done(result)
  })
  const running = t.chat('Send the draft')
  const waiting = await vi.waitFor(async () => {
    const task = (await listTasks(t.paths)).at(-1)!
    expect(task?.approvals).toHaveLength(1)
    return task
  })
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 180_000)
  try {
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect(settled).toBe(false)
    expect((await listTasks(t.paths)).at(-1)!.approvals[0]!.answer).toBeUndefined()
    await t.call('tasks:decide', waiting.id, waiting.approvals[0]!.id, 'approve')
    await running
    expect((await t.settle('done')).result).toBe('approve')
  } finally { clock.mockRestore() }
})
