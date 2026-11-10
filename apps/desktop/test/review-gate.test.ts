import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { listTasks, ROUTINE_CARD_TTL_MS, ruleFor, type ReviewRule, type VaultPaths } from 'core'

const handlers = vi.hoisted(() => new Map<string, (...args: unknown[]) => unknown>())
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => handlers.set(name, fn) } }))
vi.mock('../src/main/flog.js', () => ({ flog: () => {} }))
import { taskRunner, type TurnOutcome } from '../src/main/task-runner.js'
import { approvalsStore } from '../src/main/approvals.js'
import type { Ask } from '../src/main/page-actions.js'

const HOST = 'shop.example'
const URL_ = `https://${HOST}/checkout`
const allow = (target = HOST): ReviewRule => ({ kind: 'allow', operation: 'submit', target })
const askFirst = (target = HOST): ReviewRule => ({ kind: 'ask-first', operation: 'submit', target })
const done = (answer: string): TurnOutcome => ({ answer, asked: false, unfinished: false, steps: 1 })
type Ask1 = (words: string, url: string) => Promise<string>

async function tmpDir(prefix: string) {
  const temporary = fileURLToPath(new URL('../../../tmp/', import.meta.url))
  await mkdir(temporary, { recursive: true })
  return mkdtemp(join(temporary, prefix))
}

async function setup(script: (ask: Ask1) => Promise<string>, extra: { reviewRules?: () => Promise<readonly ReviewRule[]>; now?: () => number } = {}) {
  const root = await tmpDir('engram-review-gate-')
  const paths = { root, workspace: root, cache: join(root, '.engram'), privateDir: join(root, 'private'), inbox: join(root, 'inbox') } as unknown as VaultPaths
  await mkdir(paths.inbox, { recursive: true })
  const confirm = vi.fn<Ask>(async () => 'approve')
  let last: TurnOutcome | undefined
  const runner: ReturnType<typeof taskRunner> = taskRunner({
    paths,
    send: async (request) => {
      const ask: Ask1 = (words, url) => runner.askFor(request.channel!, confirm)!({ words, url })
      last = done(await script(ask))
    },
    outcome: () => { const o = last; last = undefined; return o },
    abort: () => {},
    broadcast: () => {},
    remember: async () => {},
    deliver: async () => {},
    notify: () => {},
    ...extra,
  })
  handlers.clear()
  runner.register()
  const decide = async (answer: 'approve' | 'decline', index = 0) => {
    const task = await card(index + 1)
    await handlers.get('tasks:decide')!({}, task.id, task.approvals[index]!.id, answer)
  }
  const card = (n: number) => vi.waitFor(async () => {
    const task = (await listTasks(paths)).at(-1)!
    expect(task.approvals).toHaveLength(n)
    return task
  }, { timeout: 5000 })
  const chat = (scheduled = false) => runner.chat({ engineId: '', botId: 'bot-1', channel: 'bot-bot-1', message: 'Order the paper', history: [], ...(scheduled ? { scheduled: true } : {}) })
  const task = async () => (await listTasks(paths)).at(-1)!
  return { paths, confirm, decide, card, chat, task }
}

describe('send action asks first by default', () => {
  it.each([
    ['absent', undefined],
    ['empty', async () => []],
    ['rejecting', async () => { throw new Error('unreadable') }],
  ] as const)('raises one card for an https submit with the reader %s', async (_name, reviewRules) => {
    const t = await setup(ask => ask('Submit order', URL_), reviewRules ? { reviewRules } : {})
    const running = t.chat()
    await t.card(1)
    await new Promise(resolve => setTimeout(resolve, 1200))
    expect(t.confirm).not.toHaveBeenCalled()
    expect((await t.task()).approvals).toHaveLength(1)
    await t.decide('approve')
    await running
    expect(t.confirm).toHaveBeenCalledTimes(1)
    expect((await t.task()).result).toBe('approve')
  })

  it('does not evaluate a file: command approval even when an allow rule names its host', async () => {
    const t = await setup(ask => ask('Run this command outside the sandbox?\nls', 'file://work.example/tmp#6c73'), { reviewRules: async () => [allow('work.example')] })
    const running = t.chat()
    await t.card(1)
    expect(t.confirm).not.toHaveBeenCalled()
    await t.decide('approve')
    await running
    expect(t.confirm).toHaveBeenCalledTimes(1)
  })
})

describe('allow rule skips card, ask-first rule wins', () => {
  it('confirms an https submit on an allowed host with no card', async () => {
    const reviewRules = vi.fn(async () => [allow()])
    const t = await setup(ask => ask('Submit order', URL_), { reviewRules })
    await t.chat()
    expect(t.confirm).toHaveBeenCalledTimes(1)
    expect(reviewRules).toHaveBeenCalledTimes(1)
    const task = await t.task()
    expect(task.approvals).toEqual([])
    expect(task.result).toBe('approve')
  })

  it.each([
    ['an ask-first rule on the same host', [allow(), askFirst()]],
    ['an allow rule for another host', [allow('other.example')]],
  ])('raises a card with %s', async (_name, rules) => {
    const t = await setup(ask => ask('Submit order', URL_), { reviewRules: async () => rules })
    const running = t.chat()
    await t.card(1)
    expect(t.confirm).not.toHaveBeenCalled()
    await t.decide('approve')
    await running
    expect(t.confirm).toHaveBeenCalledTimes(1)
  })

  it('keeps an explicit decline of the same action over a later allow rule', async () => {
    let rules: ReviewRule[] = []
    const t = await setup(async ask => {
      const first = await ask('Submit order', URL_)
      rules = [allow()]
      return `${first} ${await ask('Submit order', URL_)}`
    }, { reviewRules: async () => rules })
    const running = t.chat()
    await t.decide('decline')
    await running
    expect((await t.task()).result).toBe('cancel cancel')
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it('expires an unanswered routine card after 30 minutes as a decline', async () => {
    let offset = 0
    const t = await setup(ask => ask('Submit order', URL_), { now: () => Date.now() + offset })
    const running = t.chat(true)
    await t.card(1)
    offset = ROUTINE_CARD_TTL_MS
    await running
    const task = await t.task()
    expect(task.result).toBe('cancel')
    expect(task.approvals.map(a => [a.answer, a.settled])).toEqual([['decline', true]])
    expect(task.log.some(entry => entry.line === 'Approval card expired after 30 minutes')).toBe(true)
    expect(t.confirm).not.toHaveBeenCalled()
  })

  it('does not expire a card on a task the person started', async () => {
    let offset = 0
    const t = await setup(ask => ask('Submit order', URL_), { now: () => Date.now() + offset })
    const running = t.chat()
    await t.card(1)
    offset = ROUTINE_CARD_TTL_MS * 2
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect((await t.task()).approvals.map(a => a.answer)).toEqual([undefined])
    await t.decide('approve')
    await running
    expect(t.confirm).toHaveBeenCalledTimes(1)
  })
})

describe('approvalsStore review rules', () => {
  const seeded = async (text?: string) => {
    const dir = await tmpDir('engram-review-store-')
    if (text !== undefined) await writeFile(join(dir, 'approvals.json'), text)
    return { dir, store: approvalsStore(dir) }
  }

  it.each([
    ['a missing file', undefined],
    ['broken JSON', '{"rules": ['],
    ['an absent key', JSON.stringify({ rules: [] })],
    ['21 allow rules', JSON.stringify({ rules: [], reviewRules: Array.from({ length: 21 }, (_, i) => allow(`h${i}.example`)) })],
  ])('reads no rules from %s', async (_name, text) => {
    expect(await (await seeded(text)).store.reviewRules()).toEqual([])
  })

  it('reads valid rules and keeps them through add, forget and retire', async () => {
    const rules = [allow(), askFirst('other.example')]
    const { dir, store } = await seeded(JSON.stringify({ rules: [], reviewRules: rules }))
    expect(await store.reviewRules()).toEqual(rules)
    const kept = async () => JSON.parse(await readFile(join(dir, 'approvals.json'), 'utf8')).reviewRules as unknown
    const routine = ruleFor({ routineId: 'rt-1', kind: 'submit', host: HOST, fieldLabels: ['Entry'] })
    await store.add(routine)
    expect(await kept()).toEqual(rules)
    expect((await store.list()).map(r => r.routineId)).toEqual(['rt-1'])
    await store.forget(routine.fingerprint)
    expect(await kept()).toEqual(rules)
    await store.add(routine)
    await store.retire('rt-1')
    expect(await kept()).toEqual(rules)
    expect(await store.list()).toEqual([])
  })
})
