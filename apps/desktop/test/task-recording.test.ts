import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { EventEmitter } from 'node:events'

const state = vi.hoisted(() => ({ page: null as null | Record<string, unknown>, shot: 0, frames: [] as Buffer[], masks: [] as { selector: string }[], screenshot: vi.fn(), frame: vi.fn(), finish: vi.fn(), encoder: vi.fn(), close: vi.fn() }))
vi.mock('electron', () => ({ nativeImage: {} }))
vi.mock('../src/main/agent-browser.js', () => ({ lanePage: () => state.page }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/evidence-video.js', () => ({ videoEncoder: state.encoder }))
import { setTaskRecordingsEnabled, startTaskRecording, stopTaskRecordings } from '../src/main/task-recording.js'

let root = ''
beforeEach(async () => {
  vi.useFakeTimers()
  await setTaskRecordingsEnabled(true)
  await mkdir('tmp', { recursive: true }); root = await mkdtemp(resolve('tmp/task-recording-'))
  state.frames = []; state.masks = []; state.shot = 0; state.close.mockReset()
  state.frame.mockReset().mockImplementation(async (data: Buffer) => { state.frames.push(data) })
  state.finish.mockReset().mockResolvedValue(Buffer.from('000000186674797069736f6d', 'hex'))
  state.encoder.mockReset().mockResolvedValue({ frame: state.frame, finish: state.finish, close: state.close })
  state.screenshot.mockReset().mockImplementation(async (options: { mask: { selector: string }[] }) => { state.masks.push(...options.mask); return Buffer.from(`frame-${Math.floor(state.shot++ / 2)}`) })
  const frame = { locator: (selector: string) => ({ selector, count: async () => 1 }), url: () => 'https://example.test/report', isDetached: () => false }
  const events = new EventEmitter()
  state.page = { isClosed: () => false, url: frame.url, frames: () => [frame], screenshot: state.screenshot, on: events.on.bind(events), off: events.off.bind(events) }
})
afterEach(async () => { await stopTaskRecordings(); vi.useRealTimers(); await rm(root, { recursive: true, force: true }) })

it('saves nothing when the turn never opened a page', async () => {
  state.page = null
  const recording = startTaskRecording('bot-a', root)
  recording.observe()
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await recording.stop()).toBeNull()
  expect(await readdir(root)).toEqual([])
})

it('never captures a retained page when the current turn uses no browser tool', async () => {
  const recording = startTaskRecording('bot-a', root)
  await vi.advanceTimersByTimeAsync(5000)
  expect(await recording.stop()).toBeNull()
  expect(state.screenshot).not.toHaveBeenCalled()
  expect(state.encoder).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it('blocks a new turn with a stale enabled setting while Off is being saved', async () => {
  const disabling = setTaskRecordingsEnabled(false)
  const stale = startTaskRecording('bot-a', root)
  stale.observe()
  await disabling
  await vi.advanceTimersByTimeAsync(5000)
  expect(await stale.stop()).toBeNull()
  expect(state.screenshot).not.toHaveBeenCalled()
  await setTaskRecordingsEnabled(true)
  const next = startTaskRecording('bot-a', root)
  next.observe()
  expect(await next.stop()).toMatch(/task-recording-.*\.mp4/)
})

it('keeps only changed pictures plus the end state, masks secret fields and links the saved video once', async () => {
  const recording = startTaskRecording('bot-a', root)
  recording.observe()
  await vi.advanceTimersByTimeAsync(6_000)
  expect(state.frames.map(String)).toEqual(['frame-0', 'frame-1'])
  expect(state.masks[0]!.selector).toContain('input[type="password"]')
  expect(state.masks[0]!.selector).toContain('[autocomplete~="cc-number" i]')
  expect(state.masks[0]!.selector).toContain('[autocomplete~="one-time-code" i]')
  const link = await recording.stop()
  expect(state.frames.map(String)).toEqual(['frame-0', 'frame-1', 'frame-2'])
  expect(link).toMatch(/task-recording-.*\.mp4/)
  expect(await recording.stop()).toBe(link)
  await vi.advanceTimersByTimeAsync(6_000)
  expect(state.frames).toHaveLength(3)
  expect(state.close).toHaveBeenCalledTimes(1)
})

it('keeps the end state of a turn shorter than one frame interval', async () => {
  const recording = startTaskRecording('bot-a', root)
  recording.observe()
  await vi.advanceTimersByTimeAsync(500)
  expect(await recording.stop()).toMatch(/task-recording-.*\.mp4/)
  expect(state.frames).toHaveLength(1)
})

it.each(['abort', 'off'])('stops before the first frame without a final screenshot (%s)', async how => {
  const controller = new AbortController()
  const recording = startTaskRecording('bot-a', root, controller.signal)
  recording.observe()
  if (how === 'abort') controller.abort()
  else await stopTaskRecordings()
  recording.observe()
  expect(await recording.stop()).toBeNull()
  await vi.advanceTimersByTimeAsync(5000)
  expect(state.screenshot).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})

it.each(['abort', 'off'])('discards a screenshot that completes across cancellation (%s)', async how => {
  let finish!: (data: Buffer) => void
  state.screenshot.mockImplementation(() => new Promise<Buffer>(resolve => { finish = resolve }))
  const controller = new AbortController()
  const recording = startTaskRecording('bot-a', root, controller.signal)
  recording.observe()
  await vi.advanceTimersByTimeAsync(1500)
  expect(state.screenshot).toHaveBeenCalledOnce()
  if (how === 'abort') controller.abort()
  else await stopTaskRecordings()
  expect(await recording.stop()).toBeNull()
  finish(Buffer.from('private page after cancellation'))
  await vi.advanceTimersByTimeAsync(0)
  expect(state.frame).not.toHaveBeenCalled()
  expect(state.screenshot).toHaveBeenCalledOnce()
  expect(await readdir(root)).toEqual([])
})

it('can cancel normal final capture while it is already pending', async () => {
  state.screenshot.mockImplementation(() => new Promise(() => {}))
  const recording = startTaskRecording('bot-a', root)
  recording.observe()
  const result = recording.stop()
  await vi.advanceTimersByTimeAsync(0)
  expect(state.screenshot).toHaveBeenCalledOnce()
  await stopTaskRecordings()
  expect(await result).toBeNull()
})

it.each(['abort', 'timeout'])('does not hang on an unresponsive encoder frame (%s)', async how => {
  state.frame.mockImplementation(() => new Promise(() => {}))
  const controller = new AbortController()
  const recording = startTaskRecording('bot-a', root, controller.signal)
  recording.observe()
  await vi.advanceTimersByTimeAsync(1500)
  expect(state.frame).toHaveBeenCalledOnce()
  const result = recording.stop()
  if (how === 'abort') controller.abort()
  else await vi.advanceTimersByTimeAsync(30_000)
  expect(await result).toBeNull()
  expect(state.close).toHaveBeenCalled()
  expect(state.finish).not.toHaveBeenCalled()
})

it('closes an encoder that only becomes ready after Off', async () => {
  let ready!: (encoder: unknown) => void
  state.encoder.mockImplementation(() => new Promise(resolve => { ready = resolve }))
  const recording = startTaskRecording('bot-a', root)
  recording.observe()
  await vi.advanceTimersByTimeAsync(1500)
  await stopTaskRecordings()
  ready({ frame: state.frame, finish: state.finish, close: state.close })
  await vi.advanceTimersByTimeAsync(0)
  expect(state.close).toHaveBeenCalledOnce()
  expect(state.frame).not.toHaveBeenCalled()
  expect(await readdir(root)).toEqual([])
})
