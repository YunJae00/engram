import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import { listTasks, type VaultPaths } from 'core'
import type { ChatRequestDto, EngramEvent } from '../src/shared/types.js'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } }))
vi.mock('../src/main/flog.js', () => ({ flog: () => {} }))
import { taskRunner, type TaskTurn, type TurnOutcome } from '../src/main/task-runner.js'

type Script = (request: ChatRequestDto, turn: number, extra: TaskTurn | undefined, runner: ReturnType<typeof taskRunner>) => Promise<TurnOutcome>
export const done = (answer: string, steps = 0): TurnOutcome => ({ answer, asked: false, unfinished: false, steps })
export async function setup(script: Script, mockAcceptedCheck = true, checkBudgetMs?: number) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const root = await mkdtemp(join(temporary, 'engram-task-runner-')), paths = { root, workspace: root, cache: join(root, '.engram'), privateDir: join(root, 'private') } as unknown as VaultPaths
  const sent: { request: ChatRequestDto; extra?: TaskTurn }[] = [], events: EngramEvent[] = [], remembered: string[] = [], notified: string[] = [], learned: string[][] = [], delivered: string[] = []
  let last: TurnOutcome | undefined
  const aborted: { resolve?: () => void } = {}
  const runner: ReturnType<typeof taskRunner> = taskRunner({
    paths,
    send: async (request, extra) => {
      sent.push({ request, extra }); last = await script(request, sent.length, extra, runner)
      // These tests isolate task transitions; result-check.test.ts exercises
      // the real structured report and evidence validation.
      if (!last) return
      if (extra?.verification && mockAcceptedCheck) last.check ??= { accepted: true, issues: [] }
      // The host keeps checked work and the check itself out of the thread; the runner delivers once.
      last.held = !last.asked && (!!extra?.verification || (!last.unfinished && !!extra?.holdIf?.(last.answer, last.trail ?? [])))
    },
    outcome: () => { const o = last; last = undefined; return o },
    abort: () => { aborted.resolve?.() },
    broadcast: (event) => events.push(event),
    ...(checkBudgetMs ? { checkBudgetMs } : {}),
    remember: async (text) => { remembered.push(text) },
    notify: (task) => notified.push(`${task.state}: ${task.goal}`),
    learn: (question, answer) => learned.push([question, answer]),
    deliver: async (channel, text) => { delivered.push(text); events.push({ type: 'chat:done', channel, text }) },
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
  return { paths, runner, sent, events, remembered, notified, learned, delivered, aborted, call, chat, settle }
}

export const pressed = (target: string) => ({ tool: 'press', args: { target }, observation: `pressed "${target}"` })
export const readback = (answer: string): TurnOutcome => ({ ...done(answer, 1), trail: [{ tool: 'read_open_page', args: {}, observation: 'Current saved fields read back' }] })
