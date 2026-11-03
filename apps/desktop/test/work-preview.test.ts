import type { DesktopBinding } from '../src/main/desktop-access.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ bindings: new Map(), keptOut: vi.fn(), send: vi.fn(), image: vi.fn(), window: vi.fn(), tap: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopOwner: () => ({ webContents: { send: fake.send } }), desktopBinding: (lane: string) => fake.bindings.get(lane), keptOut: fake.keptOut }))
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
  for (let i = 1; i <= 6; i++) { const held = binding(i); held.source = 'window:shared:0'; showWorkPreview(held); await vi.advanceTimersByTimeAsync(1) }
  expect(fake.window).not.toHaveBeenCalled()
  expect(workPreviews('bot-1')).toEqual([expect.objectContaining({ lane: 'bot-1', title: 'App 1', data: 'data:image/jpeg;base64,safe' })])
  expect(workPreviews('bot-6')).toEqual([expect.objectContaining({ id: 'bot-6:window:shared:0', title: 'App 6' })])
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
it('lets the final capture finish after a turn and never resurrects closed previews', async () => {
  let finish!: (value: unknown) => void
  fake.image.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const { showWorkPreview, workPreviews, closeWorkPreview } = await import('../src/main/work-preview.js')
  const held = binding(1); showWorkPreview(held)
  fake.tap.mock.calls[0]![0]({ type: 'chat:done', channel: held.lane })
  finish({ image: { data: 'safe' } }); await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(held.lane)[0]).toMatchObject({ captureState: 'ready', current: false })
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

it('protects the first frame even while the same helper has real work pending', async () => {
  const { showWorkPreview } = await import('../src/main/work-preview.js')
  const held = binding(1)
  Object.assign(held.host, { busy: true })
  showWorkPreview(held)
  await vi.advanceTimersByTimeAsync(2100)
  expect(fake.image).toHaveBeenCalledOnce()
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

it('never reuses an image when a replacement binding reuses the same source identifier', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const first = binding(1); showWorkPreview(first); await vi.advanceTimersByTimeAsync(1)
  const replacement = { ...first, name: 'Replacement app', pid: 999 }
  fake.bindings.set(first.lane, replacement)
  fake.image.mockImplementationOnce(() => new Promise(() => {}))
  showWorkPreview(replacement)
  expect(workPreviews(first.lane)[0]).toMatchObject({ title: 'Replacement app', captureState: 'waiting' })
  expect(workPreviews(first.lane)[0]?.data).toBeUndefined()
})

it('distinguishes first-frame wait, a deferred refresh, and a previous target snapshot', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  fake.image.mockImplementationOnce(() => new Promise(() => {}))
  const held = binding(1); Object.assign(held.host, { busy: true }); showWorkPreview(held)
  expect(workPreviews(held.lane)[0]).toMatchObject({ captureState: 'waiting', current: false })
  Object.assign(held.host, { busy: false }); await vi.advanceTimersByTimeAsync(2100)
  showWorkPreview(held)
  expect(workPreviews(held.lane)[0]).toMatchObject({ captureState: 'waiting', current: false })
  const next = { ...held, source: 'window:other', name: 'Other app' }
  fake.bindings.set(held.lane, next); showWorkPreview(next)
  expect(workPreviews(held.lane).find(frame => frame.title === held.name)).toBeUndefined()
})

it('does not request capture for a protected target even before a frame exists', async () => {
  fake.keptOut.mockReturnValueOnce('Protected window')
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const held = binding(1); showWorkPreview(held)
  await vi.advanceTimersByTimeAsync(1)
  expect(fake.image).not.toHaveBeenCalled()
  expect(workPreviews(held.lane)).toEqual([])
})

it('keeps the last frame stale after refresh timeout', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const held = binding(1); showWorkPreview(held); await vi.advanceTimersByTimeAsync(3000)
  const at = workPreviews(held.lane)[0]!.at
  fake.image.mockImplementation((_binding, _observe, signal: AbortSignal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
  showWorkPreview(held); await vi.advanceTimersByTimeAsync(5001)
  expect(workPreviews(held.lane)[0]).toMatchObject({ at, data: 'data:image/jpeg;base64,safe', current: false })
})
it('settles first-frame waiting immediately when a deferred turn ends', async () => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const held = binding(1); Object.assign(held.host, { busy: true }); showWorkPreview(held)
  fake.tap.mock.calls[0]![0]({ type: 'chat:done', channel: held.lane })
  expect(workPreviews(held.lane)[0]).toMatchObject({ captureState: 'no-snapshot', current: false })
})
it.each([
  ['Allow Engram in System Settings → Privacy & Security → Screen Recording', 'screen_recording_denied'],
  ["This window's accessibility scan was incomplete.", 'capture_unsafe'],
  ['The app cannot be captured safely. Observe again', 'capture_unsafe'],
  ['Other capture failure', 'capture_unavailable'],
])('maps preview failure to a reason code: %s', async (message, captureReason) => {
  const { showWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  fake.image.mockRejectedValue(new Error(message))
  const held = binding(1); showWorkPreview(held); await vi.advanceTimersByTimeAsync(1)
  expect(workPreviews(held.lane)[0]).toMatchObject({ captureState: 'unavailable', captureReason })
  if (captureReason === 'capture_unsafe') {
    Object.assign(held.host, { busy: true })
    fake.tap.mock.calls[0]![0]({ type: 'chat:done', channel: held.lane })
    showWorkPreview(held)
    expect(workPreviews(held.lane)[0]?.captureState).toBe('unavailable')
  }
})

it('publishes an Office activity DTO without a binding or capture and retains it after completion', async () => {
  const { officeWorkPreview, workPreviews } = await import('../src/main/work-preview.js')
  const finish = officeWorkPreview('mail-lane', 'outlook.mail')
  expect(workPreviews('mail-lane')).toEqual([{ id: 'office:mail-lane', lane: 'mail-lane', title: 'Outlook', activity: 'Checking your mail', captureState: 'activity', current: true, at: expect.any(Number) }])
  expect(fake.send).toHaveBeenCalledWith('engram:event', expect.objectContaining({ type: 'desktop:preview' }))
  expect(fake.image).not.toHaveBeenCalled()
  finish()
  expect(workPreviews('mail-lane')[0]).toMatchObject({ captureState: 'activity', current: false })
  officeWorkPreview('mail-lane', 'outlook.calendar')
  fake.tap.mock.calls[0]![0]({ type: 'chat:done', channel: 'mail-lane' })
  expect(workPreviews('mail-lane')[0]).toMatchObject({ captureState: 'activity', current: false })
})

it('protects every attempt until the lane has its first frame', async () => {
  const { showWorkPreview } = await import('../src/main/work-preview.js')
  const held = binding(1)
  const request = vi.fn().mockRejectedValue(Object.assign(new Error('yield'), { name: 'PreviewPreempted' }))
  Object.assign(held.host, { request })
  fake.image.mockImplementation((_binding, observe) => observe())
  showWorkPreview(held)
  await vi.advanceTimersByTimeAsync(6301)
  expect(request.mock.calls.slice(0, 4).map(call => call[3])).toEqual([{}, {}, {}, {}])
  expect(fake.image.mock.calls.slice(0, 4).map(call => call[3])).toEqual([false, false, false, false])
  await vi.advanceTimersByTimeAsync(2100)
  expect(request.mock.calls[4]?.[3]).toEqual({})
})


it('skips snapshot requests and deferred refreshes while streaming and resumes after it ends', async () => {
  const { showWorkPreview, setWorkPreviewStream, workPreviews } = await import('../src/main/work-preview.js')
  const held = binding(1)
  const request = vi.fn().mockResolvedValue({})
  Object.assign(held.host, { request })
  fake.image.mockImplementation(async (_binding, observe) => { await observe(); return { image: { data: 'safe' } } })
  showWorkPreview(held); await vi.advanceTimersByTimeAsync(1)
  showWorkPreview(held) // Queue a refresh during the existing capture cooldown.
  request.mockClear(); fake.image.mockClear()
  setWorkPreviewStream(held.lane, true)
  showWorkPreview(held)
  await vi.advanceTimersByTimeAsync(6301)
  expect(request).not.toHaveBeenCalled()
  expect(fake.image).not.toHaveBeenCalled()
  expect(workPreviews(held.lane)).toHaveLength(1)
  setWorkPreviewStream(held.lane, false)
  await vi.advanceTimersByTimeAsync(1)
  expect(request).toHaveBeenCalledOnce()
  expect(workPreviews(held.lane)[0]).toMatchObject({ captureState: 'ready' })

  for (const reset of ['replace', 'release', 'error']) {
    setWorkPreviewStream(held.lane, true)
    if (reset === 'replace') fake.bindings.set(held.lane, { ...held })
    if (reset === 'release') fake.bindings.delete(held.lane)
    fake.tap.mock.calls[0]![0](reset === 'error' ? { type: 'chat:error', channel: held.lane } : { type: 'desktop:changed' })
    fake.bindings.set(held.lane, held)
    await vi.advanceTimersByTimeAsync(2100)
    request.mockClear()
    showWorkPreview(held); await vi.advanceTimersByTimeAsync(1)
    expect(request).toHaveBeenCalledOnce()
  }
})
