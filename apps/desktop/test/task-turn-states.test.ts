import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { appendBotTurn, AuthError, listTasks, QuotaError, readBotTranscript } from 'core'
const heard = vi.hoisted(() => ({ events: [] as { type: string; text?: string }[] }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: (event: { type: string }) => { heard.events.push(event) } }))
import { done, setup } from './task-runner-fixture.js'
import { stopper } from '../src/main/turn-stop.js'
import { signInMessage, usageLimitMessage } from '../src/main/usage-limit.js'
import type { TurnOutcome } from '../src/main/task-runner.js'

const BOT = 'bot-1', ROOM = `bot-${BOT}`
type Room = Awaited<ReturnType<typeof setup>>
type Step = (room: { say(text: string): Promise<void>; wait(): Promise<void> }, turn: number) => Promise<TurnOutcome | undefined>

async function room(ask: string, step: Step) {
  let wake: (() => void) | undefined
  let running: Promise<void> | undefined
  const say = (text: string) => appendBotTurn(t.paths, BOT, { role: 'assistant', text, at: new Date().toISOString() })
  const wait = () => new Promise<void>(resolve => { wake = resolve })
  const t: Room = await setup(async (_request, turn) => {
    const now = step({ say, wait }, turn)
    running = now.then(() => undefined, () => undefined).finally(() => { running = undefined })
    return now
  })
  const stop = stopper(t.paths, {
    ends: () => running ? [running] : [],
    goal: () => ask,
    halt: async channel => { wake?.(); if (channel) await t.runner.stopChannel(channel) },
  })
  await appendBotTurn(t.paths, BOT, { role: 'user', text: ask, at: new Date().toISOString() })
  heard.events.length = 0
  const started = t.chat(ask)
  const said = async (words?: string) => {
    if (words) await appendBotTurn(t.paths, BOT, { role: 'user', text: words, at: new Date().toISOString(), aside: true })
    return stop(ROOM, words ? '멈췄어요.' : undefined)
  }
  const stored = async () => (await readBotTranscript(t.paths, BOT)).map(turn => turn.text)
  const state = async () => (await listTasks(t.paths)).at(-1)
  return { t, started, said, stored, state, running: () => !!running }
}

const answer = '이번 달 관리비 정산표를 만들었어요. [관리비](engram-artifact:fees.xlsx)'
const unchecked = { ...done(answer, 1), check: { accepted: false, issues: ['Totals not read back'] } }
const ask = '이번 달 관리비 정산표 만들고 합계 한 번 더 봐줘'

const stops: { id: string; step: Step; ready: (r: Awaited<ReturnType<typeof room>>) => Promise<unknown>; stored: string[] }[] = [
  { id: 'S1', step: async ({ wait }) => { await wait(); return undefined }, ready: async r => vi.waitFor(() => expect(r.running()).toBe(true)), stored: [ask, '멈춰', '멈췄어요.'] },
  { id: 'S2', step: async ({ wait }) => { heard.events.push({ type: 'chat:token', text: '정산표 칸을 채우는 중' }); await wait(); return undefined }, ready: async r => vi.waitFor(() => expect(r.running()).toBe(true)), stored: [ask, '멈춰', '멈췄어요.'] },
  { id: 'S3', step: async ({ say, wait }) => { await say(answer); await wait(); return { ...done(answer, 1), delivered: true } }, ready: async r => vi.waitFor(async () => expect(await r.stored()).toContain(answer)), stored: [ask, answer, '멈춰', '멈췄어요.'] },
  { id: 'S4', step: async ({ say }) => { await say('어느 동 기준으로 할까요?'); return { ...done('어느 동 기준으로 할까요?'), asked: true } }, ready: async r => vi.waitFor(async () => expect((await r.state())?.state).toBe('waiting')), stored: [ask, '어느 동 기준으로 할까요?', '멈춰', '멈췄어요.'] },
  { id: 'S5', step: async ({ say, wait }, turn) => { if (turn === 1) { await say(answer); return unchecked } await wait(); return undefined }, ready: async r => vi.waitFor(() => { expect(r.t.sent).toHaveLength(2); expect(r.running()).toBe(true) }), stored: [ask, answer, '멈춰', '멈췄어요.'] },
]

for (const row of stops) {
  it(`${row.id}: a stop in this phase ends the task as stopped and stores exactly one stop line that survives a reload`, async () => {
    const r = await room(ask, row.step)
    await row.ready(r)
    await r.said('멈춰')
    await r.started.catch(() => undefined)
    await r.t.settle('stopped')
    expect(await r.stored()).toEqual(row.stored)
    expect(heard.events.filter(e => e.type === 'chat:done').map(e => e.text)).toEqual(['멈췄어요.'])
    expect(r.t.events.filter(e => e.type === 'chat:error')).toEqual([])
  })
}

it('S6: a stop said in words and the stop button at the same moment store one stop line', async () => {
  const r = await room(ask, async ({ say, wait }) => { await say(answer); await wait(); return { ...done(answer, 1), delivered: true } })
  await vi.waitFor(async () => expect(await r.stored()).toContain(answer))
  await appendBotTurn(r.t.paths, BOT, { role: 'user', text: '그만', at: new Date().toISOString(), aside: true })
  await Promise.all([r.said(), r.said()])
  await r.started.catch(() => undefined)
  await r.t.settle('stopped')
  expect((await r.stored()).filter(text => text === '멈췄어요.')).toHaveLength(1)
  expect(await r.said()).toBeUndefined()
  expect((await r.stored()).filter(text => text === '멈췄어요.')).toHaveLength(1)
})

it('S7: a stop when nothing is live in the room adds nothing', async () => {
  const r = await room(ask, async ({ say }) => { await say(answer); return { ...done(answer, 1), delivered: true } })
  await r.started
  await r.t.settle('done')
  const before = await r.stored()
  heard.events.length = 0
  await r.said()
  expect(await r.stored()).toEqual(before)
  expect(heard.events).toEqual([])
})

it('S8: the stop button in an English thread stores the English stop line', async () => {
  const english = 'Draft the monthly fee sheet and check the totals'
  const r = await room(english, async ({ wait }) => { await wait(); return undefined })
  await vi.waitFor(() => expect(r.running()).toBe(true))
  await r.said()
  await r.t.settle('stopped')
  expect(await r.stored()).toEqual([english, 'Stopped.'])
})

const failures: { id: string; after: boolean; fail: () => Promise<TurnOutcome | undefined>; line?: string }[] = [
  { id: 'F1', after: true, fail: async () => { throw new QuotaError('usage limit reached', 60_000) } },
  { id: 'F2', after: true, fail: async () => { throw new AuthError() } },
  { id: 'F3', after: true, fail: async () => { throw new Error('Computer access is unavailable for this connection.') } },
  { id: 'F4', after: true, fail: async () => undefined },
  { id: 'F5', after: false, fail: async () => { throw new QuotaError('usage limit reached', 60_000) }, line: usageLimitMessage(true) },
  { id: 'F6', after: false, fail: async () => { throw new AuthError() }, line: signInMessage(true) },
  { id: 'F7', after: false, fail: async () => { throw new Error('socket hang up') }, line: usageLimitMessage(true) },
  { id: 'F8', after: false, fail: async () => undefined, line: usageLimitMessage(true) },
]

for (const row of failures) {
  it(`${row.id}: a hidden turn ${row.after ? 'after' : 'before'} the answer that fails writes ${row.after ? 'nothing and keeps the answer' : 'exactly one line, stored'}`, async () => {
    const r = await room(ask, async ({ say }, turn) => {
      if (turn > 1) return row.fail()
      if (!row.after) return { ...done('', 1), unfinished: true, unfinishedReason: 'Rows not filled yet' }
      await say(answer)
      return unchecked
    })
    await r.started.catch(() => undefined)
    const task = await r.t.settle(row.after ? 'done' : 'failed')
    const errors = r.t.events.filter(e => e.type === 'chat:error')
    if (row.after) {
      expect(task.result).toBe(answer)
      expect(errors).toEqual([])
      expect(await r.stored()).toEqual([ask, answer])
    } else {
      expect(errors.map(e => 'message' in e ? e.message : '')).toEqual([row.line])
      expect(await r.stored()).toEqual([ask, row.line])
    }
  })
}

it('F9: when the person\'s own turn already wrote its failure line, the task adds no second line', async () => {
  const said = signInMessage(true)
  const r = await room(ask, async ({ say }) => { await say(said); return { answer: '', asked: false, unfinished: true, steps: 0, errored: said } })
  await r.started.catch(() => undefined)
  await r.t.settle('failed')
  expect(r.t.events.filter(e => e.type === 'chat:error')).toEqual([])
  expect(await r.stored()).toEqual([ask, said])
})

it('every row of the state table is walked by this file', () => {
  const table = readFileSync(new URL('../../../docs/spec/TASK-TURN-STATES.md', import.meta.url), 'utf8')
  const ids = [...table.matchAll(/^\| ([SF]\d+) \|/gm)].map(match => match[1])
  const walked = [...stops.map(row => row.id), 'S6', 'S7', 'S8', ...failures.map(row => row.id), 'F9']
  expect(ids.sort()).toEqual(walked.sort())
})
