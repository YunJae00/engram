import type { DesktopBinding } from '../src/main/desktop-access.js'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ bindings: new Map(), windows: [] as { webContents: { send: ReturnType<typeof vi.fn> }; setIgnoreMouseEvents: ReturnType<typeof vi.fn>; setContentProtection: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn> }[], image: vi.fn(), frame: vi.fn(), options: [] as unknown[] }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopBinding: (lane: string) => fake.bindings.get(lane), keptOut: () => undefined }))
vi.mock('../src/main/desktop-image.js', () => ({ desktopImage: fake.image }))
vi.mock('../src/main/masked-frame.js', () => ({ maskedFrame: fake.frame }))
vi.mock('electron', () => ({
  nativeImage: { createFromBuffer: () => ({ resize: () => ({ toDataURL: () => 'data:image/jpeg;base64,safe' }) }) },
  app: { once: vi.fn(), isReady: () => true }, screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 800 } }) },
  BrowserWindow: class {
    webContents = { send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn(), isLoading: () => false }
    showInactive = vi.fn(); hide = vi.fn(); destroy = vi.fn(); setIgnoreMouseEvents = vi.fn(); setContentProtection = vi.fn()
    isDestroyed = () => false
    loadFile = async () => {}; loadURL = async () => {}
    constructor(options: unknown) { fake.options.push(options); fake.windows.push(this) }
  },
}))

beforeEach(() => { vi.useFakeTimers(); vi.resetModules(); vi.clearAllMocks(); fake.bindings.clear(); fake.windows.length = 0; fake.options.length = 0; fake.image.mockResolvedValue({ image: { mimeType: 'image/jpeg', data: 'safe' } }) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
const binding = (i: number) => {
  const held = { lane: `bot-${i}`, source: `window:${i}:0`, name: `App ${i}`, readable: true, host: { closed: false }, stopped: false }
  fake.bindings.set(held.lane, held)
  return held as unknown as DesktopBinding
}

it('shows bounded previews without focus or mouse interception and expires them', async () => {
  const { showWorkPreview } = await import('../src/main/work-preview.js')
  for (let i = 1; i <= 6; i++) showWorkPreview(binding(i))
  await vi.advanceTimersByTimeAsync(1000)
  expect(fake.options).toHaveLength(1)
  expect(fake.options[0]).toMatchObject({ focusable: false, show: false, skipTaskbar: true })
  const win = fake.windows[0]
  expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
  expect(win.setContentProtection).toHaveBeenCalledWith(true)
  expect(win.showInactive).toHaveBeenCalled()
  expect(win.webContents.send.mock.lastCall[1].frames).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(25000)
  expect(win.hide).toHaveBeenCalled()
})

it('never publishes an unsafe image or resurrects a revoked preview', async () => {
  const { showWorkPreview, closeWorkPreview } = await import('../src/main/work-preview.js')
  fake.image.mockRejectedValue(new Error('protected geometry changed'))
  const held = binding(1)
  showWorkPreview(held)
  await vi.advanceTimersByTimeAsync(1000)
  const win = fake.windows[0]
  expect(win.webContents.send.mock.lastCall[1].frames[0].data).toBeUndefined()
  held.readable = false
  await vi.advanceTimersByTimeAsync(1000)
  expect(win.hide).toHaveBeenCalled()
  closeWorkPreview()
  showWorkPreview(binding(2))
  expect(fake.windows).toHaveLength(1)
})

it('drops a browser capture when its page navigates before capture completes', async () => {
  const { showBrowserWorkPreview, closeWorkPreview } = await import('../src/main/work-preview.js')
  let finish!: (data: Buffer) => void
  fake.frame.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  let url = 'https://example.com/first'
  const page = { isClosed: () => false, url: () => url } as unknown as import('playwright-core').Page
  showBrowserWorkPreview('bot', page)
  url = 'https://example.com/second'
  finish(Buffer.from('stale'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(fake.windows[0].webContents.send.mock.lastCall[1].frames[0].data).toBeUndefined()
  closeWorkPreview()
})
