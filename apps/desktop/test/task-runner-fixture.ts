import type { TurnEvidence } from 'core'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, vi } from 'vitest'
import { listTasks, writeCapture, type VaultPaths } from 'core'
import type { ChatRequestDto, EngramEvent } from '../src/shared/types.js'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } }))
vi.mock('../src/main/flog.js', () => ({ flog: () => {} }))
import { taskRunner, type TaskTurn, type TurnOutcome } from '../src/main/task-runner.js'
import { dropHeldDraft, holdTaskResult } from '../src/main/task-result-state.js'

type Script = (request: ChatRequestDto, turn: number, extra: TaskTurn | undefined, runner: ReturnType<typeof taskRunner>) => Promise<TurnOutcome | undefined>
export const done = (answer: string, steps = 0): TurnOutcome => ({ answer, asked: false, unfinished: false, steps })
export async function setup(script: Script, mockAcceptedCheck = true, checkBudgetMs?: number, offered?: (channel: string) => boolean, at?: VaultPaths) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  const root = at?.root ?? await mkdtemp(join(temporary, 'engram-task-runner-')), paths = { root, workspace: root, cache: join(root, '.engram'), privateDir: join(root, 'private'), inbox: join(root, 'inbox') } as unknown as VaultPaths
  await mkdir(paths.inbox, { recursive: true })
  const sent: { request: ChatRequestDto; extra?: TaskTurn }[] = [], events: EngramEvent[] = [], remembered: string[] = [], notified: string[] = [], learned: string[][] = [], delivered: string[] = [], deliveredTrails: NonNullable<TurnOutcome["trail"]>[] = [], evidences: TurnEvidence[] = [], deliveredAsked: (string | undefined)[] = []
  let last: TurnOutcome | undefined
  const hooks: { afterDrop?: () => Promise<void> } = {}
  const aborted: { resolve?: () => void } = {}
  const runner: ReturnType<typeof taskRunner> = taskRunner({
    paths,
    send: async (request, extra) => {
      sent.push({ request, extra }); last = await script(request, sent.length, extra, runner)
      if (!last) return
      if (extra?.verification && mockAcceptedCheck) last.check ??= { accepted: true, issues: [] }
      last.held = holdTaskResult({ answer: last.answer, steps: last.trail ?? [], asked: last.asked, ...(last.unfinished ? { incomplete: 'The turn needs continuation.' } : {}) }, extra, last.check)
      if (last.held) { await dropHeldDraft(extra, last.answer, () => events.push({ type: 'chat:token', channel: request.channel ?? '', text: '', reset: true, drop: true })); await hooks.afterDrop?.() }
    },
    outcome: () => { const o = last; last = undefined; return o },
    abort: () => { aborted.resolve?.() },
    broadcast: (event) => events.push(event),
    ...(checkBudgetMs ? { checkBudgetMs } : {}),
    ...(offered ? { offered } : {}),
    remember: async (text) => { remembered.push(text); await writeCapture(paths.inbox, text) },
    notify: (task) => notified.push(`${task.state}: ${task.goal}`),
    learn: (question, answer) => learned.push([question, answer]),
    deliver: async (channel, text, _since, trail, evidence, asked) => { delivered.push(text); deliveredAsked.push(asked); deliveredTrails.push(trail); if (evidence) evidences.push(evidence); events.push({ type: 'chat:done', channel, text }) },
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
  return { paths, runner, hooks, sent, events, remembered, notified, learned, delivered, deliveredTrails, deliveredAsked, evidences, aborted, call, chat, settle }
}

export const pressed = (target: string, committed = true) => ({ tool: 'press', args: { target }, observation: `pressed "${target}"`, ...(committed ? { committed: true } : {}) })
export const readback = (answer: string): TurnOutcome => ({ ...done(answer, 1), trail: [{ tool: 'read_open_page', args: {}, observation: 'Current saved fields read back' }] })

export const command = (text: string, folder = 'file:///tmp/work') => ({ words: `Run this command outside the sandbox?\n${text}`, url: `${folder}#${Buffer.from(text).toString('hex')}` })
export const cards = (paths: VaultPaths, n: number, not?: string) => vi.waitFor(async () => {
  const task = (await listTasks(paths)).at(-1)!
  expect(task.id).not.toBe(not)
  expect(task.approvals).toHaveLength(n)
  return task
}, { timeout: 5000 })
