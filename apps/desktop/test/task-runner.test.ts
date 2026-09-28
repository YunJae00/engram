import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createTask, findPlaybook, listTasks, updateTask, type VaultPaths } from 'core'
import type { ChatRequestDto, EngramEvent } from '../src/shared/types.js'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } }))
vi.mock('../src/main/flog.js', () => ({ flog: () => {} }))
import { taskRunner, type TaskTurn, type TurnOutcome } from '../src/main/task-runner.js'

type Script = (request: ChatRequestDto, turn: number, extra: TaskTurn | undefined, runner: ReturnType<typeof taskRunner>) => Promise<TurnOutcome>
const done = (answer: string, steps = 0): TurnOutcome => ({ answer, asked: false, unfinished: false, steps })

async function setup(script: Script) {
  const root = await mkdtemp(join(tmpdir(), 'engram-task-runner-'))
  const paths = { root, workspace: root, cache: join(root, '.engram'), privateDir: join(root, 'private') } as unknown as VaultPaths
  const sent: { request: ChatRequestDto; extra?: TaskTurn }[] = [], events: EngramEvent[] = [], remembered: string[] = [], notified: string[] = []
  let last: TurnOutcome | undefined
  const runner: ReturnType<typeof taskRunner> = taskRunner({
    paths,
    send: async (request, extra) => { sent.push({ request, extra }); last = await script(request, sent.length, extra, runner) },
    outcome: () => { const o = last; last = undefined; return o },
    abort: () => {},
    broadcast: (event) => events.push(event),
    remember: async (text) => { remembered.push(text) },
    notify: (task) => notified.push(`${task.state}: ${task.goal}`),
  })
  handlers.clear()
  runner.register()
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!({}, ...args)
  const chat = (message: string, botId = 'bot-1') => runner.chat({ engineId: '', botId, channel: `bot-${botId}`, message, history: [] })
  const settle = async (state: string) => vi.waitFor(async () => {
    const task = (await listTasks(paths)).at(-1)!
    expect(task.state).toBe(state)
    return task
  }, { timeout: 5000 })
  return { paths, runner, sent, events, remembered, notified, call, chat, settle }
}

const pressed = (target: string) => ({ tool: 'press', args: { target }, observation: `pressed "${target}"` })
const readback = (answer: string): TurnOutcome => ({ ...done(answer, 1), trail: [{ tool: 'read_open_page', args: {}, observation: 'Current saved fields read back' }] })

it('rereads a result that changed something once before calling it done, and says it stopped', async () => {
  const t = await setup(async (_r, turn) => turn === 1
    ? { ...done('Saved the supplier form', 3), trail: [{ tool: 'open_page', args: { url: 'https://portal.example/suppliers' }, observation: 'opened' }, pressed('Save')] }
    : readback('Reread the form; every field matches.'))
  await t.chat('Update the supplier address')
  const task = await t.settle('done')
  expect(task.turns).toBe(2)
  expect(task.verified).toBe(true)
  expect(task.verificationPending).toBeUndefined()
  expect(t.sent[1]!.request.message).toContain('check the result against the request below')
  expect(t.sent[1]!.request.message).toContain('The delegated task, verbatim:\nUpdate the supplier address')
  expect(task.result).toBe('Saved the supplier form\n\nChecked: Reread the form; every field matches.')
  await vi.waitFor(() => expect(t.notified).toEqual(['done: Update the supplier address']))
})

it('does not add a check turn to an answer that changed nothing', async () => {
  const t = await setup(async () => ({ ...done('Read three pages', 3), trail: [{ tool: 'open_page', args: { url: 'https://docs.example' }, observation: 'opened' }, { tool: 'press', args: { target: 'Submit' }, observation: '"Submit" was not pressed: it waits' }] }))
  await t.chat('Summarize the docs')
  expect((await t.settle('done')).turns).toBe(1)
})

it('starts a similar request from the steps that worked last time', async () => {
  const t = await setup(async (_request, turn) => turn % 2 === 0 ? readback('Checked') : ({ ...done('Filed', 4), trail: [
    { tool: 'open_page', args: { url: 'https://expenses.example/new' }, observation: 'opened' },
    { tool: 'type_text', args: { target: 'Amount' }, observation: 'typed' },
    pressed('Attach receipt'),
    pressed('Submit'),
  ] }))
  await t.chat('File the taxi receipt as an expense')
  await t.settle('done')
  expect(t.sent[0]!.extra).toBeUndefined()
  await vi.waitFor(async () => expect(await findPlaybook(t.paths, 'File the hotel receipt as an expense')).toBeDefined())
  await t.chat('File the hotel receipt as an expense')
  await vi.waitFor(async () => expect((await listTasks(t.paths)).map(x => x.state)).toEqual(['done', 'done']))
  const context = t.sent[2]!.extra?.context ?? ''
  expect(context).toContain('A similar task was finished')
  expect(context).toContain('Started from: https://expenses.example/new')
  expect(context).toContain('- press: Submit')
  expect(t.sent[2]!.request.message).toBe('File the hotel receipt as an expense')
})

it('does not accept a claimed check without a real readback or save a successful method', async () => {
  const t = await setup(async (_r, turn) => turn === 1
    ? { ...done('Saved', 1), trail: [pressed('Save')] }
    : done('Everything is correct'))
  await t.chat('Update the supplier address')
  const task = await t.settle('failed')
  expect(task.turns).toBe(8)
  expect(task.verified).not.toBe(true)
  expect(task.verificationPending).toBe(true)
  expect(await findPlaybook(t.paths, task.goal)).toBeUndefined()
})

it('keeps pending verification through a question and requires a read after a correction', async () => {
  const t = await setup(async (_r, turn) => {
    if (turn === 1) return { ...done('Saved', 1), trail: [pressed('Save')] }
    if (turn === 2) return { ...done('Which address is correct?'), asked: true }
    if (turn === 3) return { ...readback('Corrected'), trail: [...readback('').trail!, pressed('Save')] }
    return readback('Verified the correction')
  })
  await t.chat('Update the supplier address')
  const waiting = await t.settle('waiting')
  expect(waiting.verified).not.toBe(true)
  expect(waiting.verificationPending).toBe(true)
  await vi.waitFor(() => expect(t.notified).toHaveLength(1))
  await t.chat('Use the new address')
  expect((await t.settle('done')).turns).toBe(4)
  expect(t.sent[2]!.extra?.context).toContain('check the result against the request')
})

it('restores a pending check from disk without running it before the person resumes', async () => {
  const t = await setup(async () => readback('Verified after restart'))
  const task = await createTask(t.paths, 'Check saved supplier', 'bot-1')
  await updateTask(t.paths, task.id, x => { x.state = 'running'; x.turns = 1; x.verificationPending = true; x.result = 'Saved supplier' })
  await t.runner.resume()
  expect(t.sent).toHaveLength(0)
  await t.chat('Continue after checking the current state')
  expect((await t.settle('done')).verified).toBe(true)
  expect(t.sent[0]!.extra?.context).toContain('check the result against the request')
})

it('runs a comet message as a task that carries on past a turn limit, then files what it did', async () => {
  const t = await setup(async (_r, turn) => turn === 1 ? { answer: 'Half done', asked: false, unfinished: true, steps: 4 } : done('All done', 2))
  await t.chat('Reconcile the invoices')
  const task = await t.settle('done')
  expect(task.turns).toBe(2)
  expect(t.sent[0]!.request.message).toBe('Reconcile the invoices')
  expect(t.sent[0]!.extra).toBeUndefined()
  expect(t.sent[1]!.extra).toEqual({ quiet: true })
  expect(t.sent[1]!.request.message).toContain('Continue the delegated task where the last turn stopped')
  expect(t.events).toContainEqual({ type: 'comet:continue', channel: 'bot-bot-1', botId: 'bot-1' })
  await vi.waitFor(() => expect(t.remembered).toHaveLength(1))
  expect(t.remembered[0]).toContain('Reconcile the invoices')
  expect(t.remembered[0]).toContain('All done')
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
  expect((await listTasks(t.paths)).map((x) => x.state)).toEqual(['done', 'done'])
})

it('leaves committing presses for the person, one per page, and makes exactly the approved ones', async () => {
  const verdicts: string[] = []
  const t = await setup(async (request, turn, _extra, runner) => {
    const ask = runner.askFor(request.channel!, async () => 'approve')!
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
    verdicts.push(await runner.askFor(request.channel!, confirm)!({ words: 'Send', url: 'https://example.test/draft' }))
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
  await updateTask(t.paths, task.id, x => { x.state = 'waiting'; x.question = 'Continue?'; x.turns = 8 })
  await t.chat('Continue')
  expect(t.sent).toHaveLength(0)
  expect((await listTasks(t.paths))[0]!.state).toBe('failed')
})
