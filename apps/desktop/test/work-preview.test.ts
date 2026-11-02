import type { DesktopBinding } from '../src/main/desktop-access.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ bindings: new Map(), send: vi.fn(), image: vi.fn(), window: vi.fn(), tap: vi.fn() }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopOwner: () => ({ webContents: { send: fake.send } }), desktopBinding: (lane: string) => fake.bindings.get(lane), keptOut: () => undefined }))
vi.mock('../src/main/desktop-image.js', () => ({ desktopImage: fake.image }))
vi.mock('../src/main/engine-health.js', () => ({ tapBroadcast: fake.tap }))
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: () => ({ resize: () => ({ toDataURL: () => 'data:image/jpeg;base64,safe' }) }) }, app: { once: vi.fn() }, BrowserWindow: fake.window }))
beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks(); fake.bindings.clear(); fake.image.mockResolvedValue({ image: { mimeType: 'image/jpeg', data: 'safe' } }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
function binding(i: number): DesktopBinding {
  const held = { lane: `bot-${i}`, source: `window:${i}:0`, name: `App ${i}`, readable: true, host: { closed: false }, stopped: false }
  fake.bindings.set(held.lane, held)
  return held as unknown as DesktopBinding
}
it('keeps frames in their own sessions without creating an OS window', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  for (let i = 1; i <= 6; i++) { showWorkPreview(binding(i)); await vi.advanceTimersByTimeAsync(1) }
  expect(fake.window).not.toHaveBeenCalled()
  expect(workPreviews('bot-1')).toEqual([expect.objectContaining({ lane: 'bot-1', title: 'App 1', data: 'data:image/jpeg;base64,safe' })])
  expect(workPreviews('bot-6')).toHaveLength(1)
  expect(workPreviews('other')).toEqual([])
})
it('does not discard an in-flight image when a second read uses the same binding', async () => {
  let finish!: (value: unknown) => void
  fake.image.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const held = binding(1); showWorkPreview(held); showWorkPreview(held)
  finish({ image: { data: 'safe' } }); await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(held.lane)[0]?.data).toBeDefined()
})
it('does not refresh timestamps without a captured image and marks failed capture unavailable', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const held = binding(1); showWorkPreview(held); await vi.advanceTimersByTimeAsync(1)
  const at = workPreviews(held.lane)[0]!.at
  await vi.advanceTimersByTimeAsync(3000); fake.image.mockRejectedValue(new Error('protected window'))
  showWorkPreview(held); await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(held.lane)[0]).toMatchObject({ at, unavailable: true })
  expect(workPreviews(held.lane)[0]?.data).toBeUndefined()
})
it('drops delayed images after the target changes or access is revoked', async () => {
  let finish!: (value: unknown) => void
  fake.image.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const held = binding(1); showWorkPreview(held); binding(1)
  finish({ image: { data: 'stale' } }); await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(held.lane)).toEqual([])
})
it('cancels pending capture when the turn ends and never resurrects closed previews', async () => {
  fake.image.mockImplementation((_binding, _observe, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))))
  const { showWorkPreview, workPreviews, closeWorkPreview } = await import('../src/main/work-preview.js')
  const held = binding(1); showWorkPreview(held)
  fake.tap.mock.calls[0]![0]({ type: 'chat:done', channel: held.lane })
  await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(held.lane)[0]?.unavailable).toBe(true)
  closeWorkPreview(); showWorkPreview(binding(2))
  expect(workPreviews('bot-2')).toEqual([])
})

it('keeps prior snapshots in the same session until access is revoked without recapturing old targets', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const first = binding(1); showWorkPreview(first); await vi.advanceTimersByTimeAsync(1)
  const next = { ...first, source: 'window:2:0', name: 'Other app' }
  fake.bindings.set(first.lane, next)
  showWorkPreview(next); await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(first.lane).map(frame => frame.title)).toEqual(['Other app', 'App 1'])
  next.readable = false
  expect(workPreviews(first.lane)).toEqual([])
})

it('preserves a confirmed snapshot when its refresh fails after switching targets', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const first = binding(1); showWorkPreview(first); await vi.advanceTimersByTimeAsync(3000)
  const at = workPreviews(first.lane)[0]!.at
  let reject!: (error: Error) => void
  fake.image.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  showWorkPreview(first)
  const next = { ...first, source: 'window:2:0', name: 'Other app' }
  fake.bindings.set(first.lane, next); showWorkPreview(next)
  reject(new Error('The app changed before the screenshot was ready.'))
  await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(first.lane)).toHaveLength(2)
  expect(workPreviews(first.lane)[1]).toMatchObject({ at, data: 'data:image/jpeg;base64,safe', unavailable: false })
})

it('defers preview capture while the same helper has real work pending', async () => {
  const { showWorkPreview } = await import('../src/main/work-preview.js')
  const held = binding(1)
  Object.assign(held.host, { busy: true })
  showWorkPreview(held)
  await vi.advanceTimersByTimeAsync(2100)
  expect(fake.image).not.toHaveBeenCalled()
  Object.assign(held.host, { busy: false })
  await vi.advanceTimersByTimeAsync(2100)
  expect(fake.image).toHaveBeenCalledOnce()
})

it('keeps the last confirmed image and timestamp when a refresh yields to real work', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const held = binding(1); showWorkPreview(held); await vi.advanceTimersByTimeAsync(1)
  const previous = workPreviews(held.lane)[0]
  await vi.advanceTimersByTimeAsync(3000)
  fake.image.mockRejectedValue(Object.assign(new Error('Preview yielded to app work'), { name: 'PreviewPreempted' }))
  showWorkPreview(held); await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(held.lane)[0]).toMatchObject({ data: previous?.data, at: previous?.at, unavailable: false })
})
