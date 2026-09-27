import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createTask, listTasks, updateTask, type VaultPaths } from 'core'
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
  const sent: { request: ChatRequestDto; extra?: TaskTurn }[] = [], events: EngramEvent[] = [], remembered: string[] = []
  let last: TurnOutcome | undefined
  const runner: ReturnType<typeof taskRunner> = taskRunner({
    paths,
    send: async (request, extra) => { sent.push({ request, extra }); last = await script(request, sent.length, extra, runner) },
    outcome: () => { const o = last; last = undefined; return o },
    abort: () => {},
    broadcast: (event) => events.push(event),
    remember: async (text) => { remembered.push(text) },
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
  return { paths, runner, sent, events, remembered, call, chat, settle }
}

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
