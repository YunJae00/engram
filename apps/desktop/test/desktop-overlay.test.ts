import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopControlStatusDto } from '../src/shared/desktop.js'

type Listener = (...args: unknown[]) => void

const fake = vi.hoisted(() => {
  class WindowDouble {
    static all: WindowDouble[] = []
    static nextId = 1
    options: Record<string, unknown>
    listeners = new Map<string, Listener[]>()
    destroyed = false
    visible = false
    setAlwaysOnTop = vi.fn()
    setIgnoreMouseEvents = vi.fn()
    setContentProtection = vi.fn()
    setVisibleOnAllWorkspaces = vi.fn()
    setBounds = vi.fn()
    showInactive = vi.fn(() => { this.visible = true })
    hide = vi.fn(() => { this.visible = false })
    destroy = vi.fn(() => { this.destroyed = true })
    loadURL = vi.fn(() => Promise.resolve())
    loadFile = vi.fn(() => Promise.resolve())
    isDestroyed = (): boolean => this.destroyed
    isVisible = (): boolean => this.visible
    getNativeWindowHandle = (): Buffer => { const value = Buffer.alloc(8); value.writeBigUInt64LE(BigInt(this.webContents.id)); return value }
    webContents = {
      id: WindowDouble.nextId++,
      send: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(() => Promise.resolve('')),
    }
    constructor(options: Record<string, unknown>) {
      this.options = options
      WindowDouble.all.push(this)
    }
    on(event: string, listener: Listener): this {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener])
      return this
    }
    once(event: string, listener: Listener): this {
      return this.on(event, listener)
    }
    emit(event: string): void {
      for (const listener of this.listeners.get(event) ?? []) listener()
    }
  }
  const screen = {
    displays: [] as { bounds: { x: number; y: number; width: number; height: number } }[],
    cursor: { x: 10, y: 10 },
    getAllDisplays: vi.fn(() => screen.displays),
    getCursorScreenPoint: vi.fn(() => screen.cursor),
    on: vi.fn(),
  }
  const app = { on: vi.fn() }
  return { WindowDouble, screen, app }
})
vi.mock('electron', () => ({ BrowserWindow: fake.WindowDouble, screen: fake.screen, app: fake.app }))

type Overlay = typeof import('../src/main/desktop-overlay.js')
let overlay: Overlay
const running: DesktopControlStatusDto = { state: 'running', engine: 'claude', engineLabel: 'Claude' }

function windows(): InstanceType<typeof fake.WindowDouble>[] {
  return fake.WindowDouble.all.filter((win) => !win.destroyed)
}
function glows(): InstanceType<typeof fake.WindowDouble>[] {
  return windows().filter((win) => win.setIgnoreMouseEvents.mock.calls.length > 0)
}
function pill(): InstanceType<typeof fake.WindowDouble> {
  const found = windows().find((win) => win.setIgnoreMouseEvents.mock.calls.length === 0)
  if (!found) throw new Error('no pill window')
  return found
}
function sentEvents(win: InstanceType<typeof fake.WindowDouble>): unknown[] {
  return win.webContents.send.mock.calls.map(([, event]) => event)
}
function screenListener(event: string): Listener {
  const found = fake.screen.on.mock.calls.find(([name]) => name === event)
  if (!found) throw new Error(`no listener for ${event}`)
  return found[1] as Listener
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  fake.WindowDouble.all = []
  fake.WindowDouble.nextId = 1
  fake.screen.displays = [{ bounds: { x: 0, y: 0, width: 1280, height: 800 } }, { bounds: { x: 1280, y: 0, width: 1920, height: 1080 } }]
  fake.screen.cursor = { x: 10, y: 10 }
  fake.screen.on.mockClear()
  fake.app.on.mockClear()
  overlay = await import('../src/main/desktop-overlay.js')
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('control overlay windows', () => {
  it('waits for the visible pill before handing its native handle to input control', async () => {
    const pending = overlay.prepareControlOverlay(running)
    await vi.advanceTimersByTimeAsync(6000)
    expect(pill().isVisible()).toBe(false)
    pill().emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(25)
    await expect(pending).resolves.toBe(String(pill().webContents.id))
  })

  it('fails closed when an overlay is cancelled during loading', async () => {
    const pending = overlay.prepareControlOverlay(running)
    const rejected = expect(pending).rejects.toThrow('stop overlay is unavailable')
    overlay.hideControlOverlay()
    pill().emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(25)
    await rejected
    expect(pill().isVisible()).toBe(false)
  })
  it('opens one click-through, non-focusable, content-protected glow per display and one pill that takes clicks', () => {
    overlay.showControlOverlay(running)
    expect(glows()).toHaveLength(2)
    for (const [index, glow] of glows().entries()) {
      // One row short of the display: the exact size reads as fullscreen and
      // loses transparency.
      const bounds = fake.screen.displays[index]!.bounds
      expect(glow.options).toMatchObject({
        ...bounds, height: bounds.height - 1,
        transparent: true, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, type: 'toolbar', show: false,
      })
      expect(glow.options['webPreferences']).toMatchObject({ contextIsolation: true, nodeIntegration: false, backgroundThrottling: false })
      expect(glow.setIgnoreMouseEvents).toHaveBeenCalledWith(true)
      expect(glow.setContentProtection).toHaveBeenCalledWith(true)
      expect(glow.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
      expect(glow.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[\\/]index\.html$/), { hash: 'overlay' })
    }
    const pillWin = pill()
    expect(pillWin.options).toMatchObject({ transparent: true, frame: false, focusable: false, skipTaskbar: true, type: 'toolbar', width: 440 })
    expect(pillWin.setIgnoreMouseEvents).not.toHaveBeenCalled()
    expect(pillWin.setContentProtection).toHaveBeenCalledWith(true)
    expect(pillWin.loadFile).toHaveBeenCalledWith(expect.anything(), { hash: 'overlay-pill' })
    // Top-centre of the display under the pointer (the first one here).
    expect(pillWin.options).toMatchObject({ x: 420, y: 12 })
  })

  it('shows windows without activating them once they are ready, and never before', () => {
    overlay.showControlOverlay(running)
    for (const win of windows()) expect(win.showInactive).not.toHaveBeenCalled()
    for (const win of windows()) win.emit('ready-to-show')
    for (const win of windows()) expect(win.showInactive).toHaveBeenCalledOnce()
    expect(windows().flatMap((win) => Object.keys(win))).not.toContain('focus')
  })

  it('sends the control status to every window on show, on update and again when a window finishes loading', () => {
    overlay.showControlOverlay(running)
    for (const win of windows()) expect(sentEvents(win)).toEqual([{ type: 'desktop:control', control: running }])
    const paused: DesktopControlStatusDto = { state: 'paused', resumable: true, engine: 'claude', engineLabel: 'Claude' }
    overlay.updateControlOverlay(paused)
    for (const win of windows()) expect(sentEvents(win).at(-1)).toEqual({ type: 'desktop:control', control: paused })
    const first = glows()[0]!
    const finished = first.webContents.on.mock.calls.find(([name]) => name === 'did-finish-load')?.[1] as Listener
    finished()
    expect(sentEvents(first)).toHaveLength(3)
    expect(sentEvents(first).at(-1)).toEqual({ type: 'desktop:control', control: paused })
  })

  it('locks navigation and child windows on every overlay window', () => {
    overlay.showControlOverlay(running)
    for (const win of windows()) {
      const events = win.webContents.on.mock.calls.map(([name]) => name)
      expect(events).toEqual(expect.arrayContaining(['will-navigate', 'will-redirect']))
      expect(win.webContents.setWindowOpenHandler).toHaveBeenCalledOnce()
      const handler = win.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => { action: string }
      expect(handler()).toEqual({ action: 'deny' })
    }
  })
})

describe('control overlay pointer', () => {
  it('routes a comet pointer only to the display that holds it, in that window coordinates', () => {
    overlay.showControlOverlay(running)
    overlay.overlayPointer({ x: 1300, y: 40 })
    const [first, second] = glows()
    expect(sentEvents(first!).filter((event) => (event as { type: string }).type === 'desktop:pointer')).toEqual([])
    expect(sentEvents(second!).at(-1)).toEqual({ type: 'desktop:pointer', x: 20, y: 40 })
    overlay.overlayPointer({ x: 100, y: 50 }, true)
    expect(sentEvents(first!).at(-1)).toEqual({ type: 'desktop:pointer', x: 100, y: 50, press: true })
    expect(sentEvents(pill()).some((event) => (event as { type: string }).type === 'desktop:pointer')).toBe(false)
  })

  it('polls the native pointer at about thirty hertz while shown and stops when hidden', () => {
    overlay.showControlOverlay(running)
    const first = glows()[0]!
    fake.screen.cursor = { x: 200, y: 300 }
    vi.advanceTimersByTime(40)
    expect(sentEvents(first).at(-1)).toEqual({ type: 'desktop:pointer', x: 200, y: 300 })
    const before = sentEvents(first).length
    vi.advanceTimersByTime(200)
    expect(sentEvents(first)).toHaveLength(before)
    overlay.hideControlOverlay()
    for (const win of windows()) expect(win.hide).toHaveBeenCalledOnce()
    for (const win of windows()) expect(sentEvents(win).at(-1)).toEqual({ type: 'desktop:control', control: { state: 'idle' } })
    const afterHide = sentEvents(first).length
    fake.screen.cursor = { x: 5, y: 5 }
    vi.advanceTimersByTime(500)
    expect(sentEvents(first)).toHaveLength(afterHide)
    expect(fake.screen.getCursorScreenPoint.mock.calls.length).toBeGreaterThan(0)
  })

  it('ignores a comet pointer while hidden', () => {
    overlay.showControlOverlay(running)
    overlay.hideControlOverlay()
    const first = glows()[0]!
    const count = sentEvents(first).length
    overlay.overlayPointer({ x: 1, y: 1 })
    expect(sentEvents(first)).toHaveLength(count)
  })
})

describe('control overlay lifetime', () => {
  it('renews the topmost claim every five seconds while shown', () => {
    overlay.showControlOverlay(running)
    for (const win of windows()) win.emit('ready-to-show')
    for (const win of windows()) win.setAlwaysOnTop.mockClear()
    vi.advanceTimersByTime(5000)
    for (const win of windows()) expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver')
  })

  it('rebuilds the windows when display metrics change and re-shows them if still controlling', () => {
    overlay.showControlOverlay(running)
    const old = windows()
    fake.screen.displays = [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 } }]
    screenListener('display-metrics-changed')()
    screenListener('display-metrics-changed')()
    vi.advanceTimersByTime(250)
    for (const win of old) expect(win.destroy).toHaveBeenCalledOnce()
    expect(glows()).toHaveLength(1)
    expect(glows()[0]!.options).toMatchObject({ width: 2560, height: 1439 })
    for (const win of windows()) win.emit('ready-to-show')
    for (const win of windows()) expect(win.showInactive).toHaveBeenCalledOnce()
    // The fresh windows carry the status, and the pointer poll is running again.
    expect(sentEvents(glows()[0]!)).toContainEqual({ type: 'desktop:control', control: running })
    expect(sentEvents(glows()[0]!)).toContainEqual({ type: 'desktop:pointer', x: 10, y: 10 })
  })

  it('lists the live webContents ids and drops them on quit', () => {
    overlay.showControlOverlay(running)
    expect(overlay.overlayWindowIds()).toEqual(windows().map((win) => win.webContents.id))
    const quit = fake.app.on.mock.calls.find(([name]) => name === 'before-quit')?.[1] as Listener
    quit()
    expect(overlay.overlayWindowIds()).toEqual([])
    for (const win of fake.WindowDouble.all) expect(win.destroy).toHaveBeenCalledOnce()
  })

  it('keeps hidden windows for the next session and never rebuilds them while hidden', () => {
    overlay.showControlOverlay(running)
    overlay.hideControlOverlay()
    const count = fake.WindowDouble.all.length
    overlay.showControlOverlay(running)
    expect(fake.WindowDouble.all).toHaveLength(count)
    for (const win of windows()) expect(win.destroy).not.toHaveBeenCalled()
  })

  it('survives a window that throws instead of failing the control loop', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.screen.getAllDisplays.mockImplementationOnce(() => { throw new Error('no screen') })
    expect(() => overlay.showControlOverlay(running)).not.toThrow()
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
