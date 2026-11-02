import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { appendBotTurn, initVault, readBotTranscript } from 'core'
const bus = vi.hoisted(() => ({ receive: (() => {}) as (event: unknown) => void }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: (event: unknown) => bus.receive(event) }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
import { asides } from '../src/main/turn-state.js'
import { conversationProgress, finishProgress, progressWork } from '../src/main/conversation-progress.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
it('persists observed progress before steering and final results without duplicating final text', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp/progress-')); roots.push(root)
  const paths = await initVault(root, { git: false })
  const progress = conversationProgress(paths)
  const channel = 'bot-progress'
  await appendBotTurn(paths, 'progress', { role: 'user', text: 'Read four items', at: 'start' })
  progress.observe({ type: 'chat:token', channel, text: 'Two checked.' })
  progress.observe({ type: 'chat:token', channel, text: '', reset: true })
  progress.observe({ type: 'chat:token', channel, text: 'Checking the dates.' })
  await progress.flush(channel)
  await appendBotTurn(paths, 'progress', { role: 'user', text: 'Include dates', at: 'steer' })
  progress.observe({ type: 'chat:token', channel, text: 'All four confirmed.' })
  await appendBotTurn(paths, 'progress', { role: 'assistant', text: 'All four confirmed.', at: 'end' })
  progress.observe({ type: 'chat:done', channel, text: 'All four confirmed.' })
  await progress.flush(channel)
  const turns = await readBotTranscript(paths, 'progress')
  expect(turns.map(turn => turn.text)).toEqual(['Read four items', 'Two checked.', 'Checking the dates.', 'Include dates', 'All four confirmed.'])
  expect(turns.filter(turn => turn.progress)).toHaveLength(2)
})

it('normalizes a final answer before persistence after an in-flight user message', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp/progress-')); roots.push(root)
  const paths = await initVault(root, { git: false })
  const progress = conversationProgress(paths)
  progress.observe({ type: 'chat:token', channel: 'bot-fragment', text: 'Two checked. ' })
  await progress.flush('bot-fragment')
  await appendBotTurn(paths, 'fragment', { role: 'user', text: 'Include dates', at: 'steer' })
  const answer = finishProgress('bot-fragment', 'Two checked. The dates are confirmed.')
  await appendBotTurn(paths, 'fragment', { role: 'assistant', text: answer, at: 'end' })
  expect((await readBotTranscript(paths, 'fragment')).map(turn => turn.text)).toEqual(['Two checked. ', 'Include dates', 'Two checked. The dates are confirmed.'])
  expect(finishProgress('bot-fragment', 'Two checked. A new answer.')).toBe('Two checked. A new answer.')
})

it('flushes pending words before recording the next observed operation', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp/progress-')); roots.push(root)
  const paths = await initVault(root, { git: false })
  const progress = conversationProgress(paths)
  bus.receive = event => progress.observe(event as Parameters<typeof progress.observe>[0])
  progress.observe({ type: 'comet:step', channel: 'bot-order', line: 'app_read: Fixture' })
  progress.observe({ type: 'chat:token', channel: 'bot-order', text: 'The first item is confirmed.' })
  progress.observe({ type: 'comet:step', channel: 'bot-order', line: 'app_read: Next region' })
  await appendBotTurn(paths, 'order', { role: 'assistant', text: 'Final', at: 'end' })
  const turns = await readBotTranscript(paths, 'order')
  expect(turns[0]).toMatchObject({ progress: true, text: 'The first item is confirmed.', work: ['app_read: Fixture'] })
  expect(progressWork('bot-order')).toEqual(['app_read: Next region'])
})

it('masks secrets introduced by steering in persisted progress and final output', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp/progress-')); roots.push(root)
  const paths = await initVault(root, { git: false })
  const progress = conversationProgress(paths)
  const channel = 'bot-private'
  asides.set(channel, [{ role: 'user', text: 'My password is hunter2' }])
  try {
    progress.observe({ type: 'comet:step', channel, line: 'Checked hunter2' })
    progress.observe({ type: 'chat:token', channel, text: 'I saw hunter2.' })
    await progress.flush(channel)
    expect(JSON.stringify(await readBotTranscript(paths, 'private'))).not.toContain('hunter2')
    expect(finishProgress(channel, 'I saw hunter2. Finished checking hunter2.')).not.toContain('hunter2')
  } finally { asides.delete(channel) }
})

it('keeps an in-flight capture intact for the inbox writer after steering', async () => {
  const root = await mkdtemp(join(process.cwd(), 'tmp/progress-')); roots.push(root)
  const paths = await initVault(root, { git: false })
  const progress = conversationProgress(paths)
  progress.observe({ type: 'chat:token', channel: 'bot-capture', text: 'I will remember it.\n<engram:capture>Keep' })
  await progress.flush('bot-capture')
  expect(finishProgress('bot-capture', 'I will remember it.\n<engram:capture>Keep this note</engram:capture>'))
    .toBe('I will remember it.\n<engram:capture>Keep this note</engram:capture>')
})
