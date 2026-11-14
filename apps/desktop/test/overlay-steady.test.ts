import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DesktopBinding } from '../src/main/desktop-access.js'
import type { DesktopHost } from '../src/main/desktop-host.js'
import type { DesktopControlStatusDto } from '../src/shared/desktop.js'

type Listener = (...args: unknown[]) => void
const fake = vi.hoisted(() => {
  class WindowDouble {
    static all: WindowDouble[] = []
    static nextId = 1
    listeners = new Map<string, Listener[]>()
    destroyed = false
    visible = false
    announced = false
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
    webContents = { id: WindowDouble.nextId++, send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn(), insertCSS: vi.fn(() => Promise.resolve('')) }
    constructor(public options: Record<string, unknown>) { WindowDouble.all.push(this) }
    on(event: string, listener: Listener): this { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this }
    once(event: string, listener: Listener): this { return this.on(event, listener) }
    emit(event: string): void { for (const listener of this.listeners.get(event) ?? []) listener() }
  }
  const screen = {
    getAllDisplays: () => [{ bounds: { x: 0, y: 0, width: 1280, height: 800 } }, { bounds: { x: 1280, y: 0, width: 1920, height: 1080 } }],
    getCursorScreenPoint: () => ({ x: 10, y: 10 }),
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 760 } }),
    screenToDipRect: (_: unknown, rect: unknown) => rect,
    screenToDipPoint: (point: unknown) => point,
    on: vi.fn(),
  }
  return { WindowDouble, screen, bindings: new Map<string, unknown>(), broadcast: vi.fn(), request: vi.fn(), close: vi.fn() }
})
vi.mock('electron', () => ({ BrowserWindow: fake.WindowDouble, screen: fake.screen, app: { on: vi.fn() } }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: vi.fn() }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fake.broadcast }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: class { request = fake.request; close = fake.close } }))
vi.mock('../src/main/desktop-access.js', () => ({
  rememberLaunchedApp: vi.fn(), refreshHiddenApp: async (binding: unknown) => binding, desktopForeground: async () => ({ pid: 99, title: 'Previous' }),
  rememberOpenedForeground: vi.fn(), rememberHiddenApp: vi.fn(), desktopChanged: vi.fn(), setDesktopReleaseHook: vi.fn(),
  desktopBinding: (lane: string) => fake.bindings.get(lane),
  bindDesktopForLane: async (lane: string) => { const held = fake.bindings.get(lane) as DesktopBinding; held.readable = true; return held },
}))

const lane = 'bot-first'
let control: typeof import('../src/main/desktop-control.js')
let overlay: typeof import('../src/main/desktop-overlay.js')
let work: typeof import('../src/main/application-work.js')
const input = { escaped: false, fail: false, serial: 0 }
const app = { foreground: true, minimized: false, escaped: false }
const target = { window: '100', pid: 23, bounds: { x: 10, y: 20, width: 900, height: 600 } }
const frames: { method: string; at: number }[] = []

function binding() {
  let serial = 0
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'bind') return { lease: 'native-100' }
    if (method === 'observe') return { snapshot: `snapshot-${++serial}`, nodes: [{ id: 'e0', name: 'Editor', controlType: 'Edit', bounds: { x: 0, y: 20, width: 200, height: 100 } }], bounds: { x: 0, y: 20, width: 200, height: 100 }, captureBounds: { x: 8, y: 44, width: 184, height: 68 } }
    if (method === 'inputState') {
      if (input.fail) throw new Error('input monitor unavailable')
      return { idleMs: 5000, escaped: input.escaped, intervention: `i${input.escaped ? ++input.serial : 0}` }
    }
    return { ok: true }
  })
  const value = { lane, source: 'window:100:0', name: 'Editor', window: '100', pid: 200, readable: false, stopped: false, revision: 0, host: { request, close: vi.fn(), closed: false } as unknown as DesktopHost } as DesktopBinding
  fake.bindings.set(lane, value)
  return request
}
const windows = () => fake.WindowDouble.all.filter(win => !win.destroyed)
const pill = () => windows().find(win => win.setIgnoreMouseEvents.mock.calls.length === 0)!
const controls = (calls: unknown[][], from = 0): DesktopControlStatusDto[] => calls.slice(from).map(call => call.at(-1) as { type: string; control: DesktopControlStatusDto }).filter(event => event.type === 'desktop:control').map(event => event.control)
const released = (calls: unknown[][], from = 0) => controls(calls, from).filter(status => status.state === 'running' && status.inputActive === false && !status.application)
const count = (request: { mock: { calls: unknown[][] } }, method: string) => request.mock.calls.filter(([name]) => name === method).length
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false
  promise.then(() => { done = true }, () => { done = true })
  for (let turn = 0; turn < 200 && !done; turn++) {
    for (const win of windows()) if (!win.announced) { win.announced = true; win.emit('ready-to-show') }
    await vi.advanceTimersByTimeAsync(0)
    if (!done) await vi.advanceTimersByTimeAsync(25)
  }
  return promise
}
const read = () => settle(control.withDesktopActivity(lane, () => control.readControlledDesktop(lane, undefined, true)))
const click = (snapshot: string) => settle(control.withDesktopActivity(lane, () => control.actOnDesktop(lane, { kind: 'click', snapshot, element: 'e0' })))

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  fake.WindowDouble.all = []
  fake.bindings.clear()
  fake.broadcast.mockReset()
  fake.close.mockReset()
  frames.length = 0
  Object.assign(input, { escaped: false, fail: false, serial: 0 })
  Object.assign(app, { foreground: true, minimized: false, escaped: false })
  fake.request.mockReset().mockImplementation(async (method: string) => {
    if (method === 'inputState') return { escaped: app.escaped }
    if (method.startsWith('applicationFrame')) frames.push({ method, at: Date.now() })
    return { ...target, foreground: app.foreground, minimized: app.minimized }
  })
  control = await import('../src/main/desktop-control.js')
  overlay = await import('../src/main/desktop-overlay.js')
  work = await import('../src/main/application-work.js')
  control.setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
})
afterEach(() => {
  work.clearApplicationWork()
  control.stopDesktopControl('Test cleanup')
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('consecutive desktop actions in one lane', () => {
  it('reveal the overlay once and announce released input once, only after the last action', async () => {
    const request = binding()
    const first = await read()
    expect(request.mock.calls.at(-1)?.[0]).toBe('idle')
    expect(control.desktopControlStatus().inputActive).toBe(false)
    const shownFrom = pill().webContents.send.mock.calls.length
    await vi.advanceTimersByTimeAsync(300)
    await click(first.snapshot)
    expect(request.mock.calls.at(-1)?.[0]).toBe('idle')
    expect(control.desktopControlStatus().inputActive).toBe(false)
    expect(released(fake.broadcast.mock.calls)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(300)
    await read()
    expect(request.mock.calls.at(-1)?.[0]).toBe('idle')
    expect(windows()).toHaveLength(3)
    for (const win of windows()) expect(win.showInactive).toHaveBeenCalledTimes(1)
    expect([count(request, 'bind'), count(request, 'work'), count(request, 'idle')]).toEqual([1, 2, 3])
    expect(released(fake.broadcast.mock.calls)).toHaveLength(0)
    expect(released(pill().webContents.send.mock.calls, shownFrom)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1499)
    expect(released(fake.broadcast.mock.calls)).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(released(fake.broadcast.mock.calls)).toHaveLength(1)
    expect(released(pill().webContents.send.mock.calls, shownFrom)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(5000)
    expect(released(fake.broadcast.mock.calls)).toHaveLength(1)
  })
  it('stop at once on Escape and send no late running status', async () => {
    binding()
    await read()
    input.escaped = true
    await expect(read()).rejects.toThrow()
    const stopped = controls(fake.broadcast.mock.calls).at(-1)
    expect(stopped?.state).not.toBe('running')
    expect(overlay.overlayStatus().state).toBe('idle')
    const sent = fake.broadcast.mock.calls.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(controls(fake.broadcast.mock.calls, sent).filter(status => status.state === 'running')).toHaveLength(0)
  })
  it('still report released input when the next start fails', async () => {
    binding()
    const first = await read()
    await click(first.snapshot)
    expect(controls(fake.broadcast.mock.calls).at(-1)?.inputActive).toBe(true)
    input.fail = true
    await expect(read()).rejects.toThrow()
    await vi.advanceTimersByTimeAsync(3000)
    expect(controls(fake.broadcast.mock.calls).at(-1)?.inputActive).not.toBe(true)
  })
  it('reveal again for another lane and stay put for the same one', async () => {
    await settle(overlay.prepareControlOverlay({ state: 'running', lane: 'a' }))
    await overlay.prepareControlOverlay({ state: 'running', lane: 'a' })
    expect(pill().showInactive).toHaveBeenCalledTimes(1)
    await settle(overlay.prepareControlOverlay({ state: 'running', lane: 'b' }))
    expect(pill().showInactive).toHaveBeenCalledTimes(2)
    await settle(overlay.prepareControlOverlay({ state: 'running', lane: 'b', application: { name: 'Word', bounds: target.bounds, visible: true, nativeFrame: true } }))
    expect(pill().showInactive).toHaveBeenCalledTimes(3)
  })
})

describe('the native application frame', () => {
  const hides = () => frames.filter(frame => frame.method === 'applicationFrameHide')
  const hidden = () => controls(pill().webContents.send.mock.calls).filter(status => status.application?.visible === false)
  it('survives a 200 ms foreground blip, re-shown faster than the native 150 ms hide poll', async () => {
    const held = work.applicationWork('one')
    await settle(held.show('100', 'Word'))
    await vi.advanceTimersByTimeAsync(500)
    app.foreground = false
    const lost = Date.now()
    await vi.advanceTimersByTimeAsync(200)
    const blip = frames.filter(frame => frame.at > lost)
    expect(blip.length).toBeGreaterThan(0)
    expect(blip[0]!.at - lost).toBeLessThan(150)
    expect(Math.max(...blip.slice(1).map((frame, index) => frame.at - blip[index]!.at))).toBeLessThan(150)
    app.foreground = true
    await vi.advanceTimersByTimeAsync(300)
    const steady = frames.length
    await vi.advanceTimersByTimeAsync(2000)
    expect(hides()).toHaveLength(0)
    expect(hidden()).toHaveLength(0)
    expect(frames).toHaveLength(steady)
  })
  it('is not re-shown on every poll while the window keeps the foreground', async () => {
    const held = work.applicationWork('one')
    await settle(held.show('100', 'Word'))
    const shows = frames.length
    await vi.advanceTimersByTimeAsync(3000)
    expect(frames).toHaveLength(shows)
    expect(overlay.overlayStatus().application?.visible).toBe(true)
  })
  it('hides only after the foreground stayed lost for a second, and returns at once', async () => {
    const held = work.applicationWork('one')
    await settle(held.show('100', 'Word'))
    app.foreground = false
    await vi.advanceTimersByTimeAsync(900)
    expect(hides()).toHaveLength(0)
    expect(overlay.overlayStatus().application?.visible).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(hides()).toHaveLength(1)
    expect(overlay.overlayStatus().application?.visible).toBe(false)
    const shows = frames.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(frames).toHaveLength(shows)
    app.foreground = true
    await vi.advanceTimersByTimeAsync(100)
    expect(frames.at(-1)?.method).toBe('applicationFrame')
    expect(overlay.overlayStatus().application?.visible).toBe(true)
    expect(held.signal.aborted).toBe(false)
  })
  it('lets the native poll drop a minimized window without keeping it alive', async () => {
    const held = work.applicationWork('one')
    await settle(held.show('100', 'Word'))
    await vi.advanceTimersByTimeAsync(300)
    app.minimized = true
    const from = frames.length
    await vi.advanceTimersByTimeAsync(900)
    expect(frames).toHaveLength(from)
    await vi.advanceTimersByTimeAsync(300)
    expect(frames.slice(from).map(frame => frame.method)).toEqual(['applicationFrameHide'])
  })
  it('stops at once on Escape while a lost foreground is being held', async () => {
    const held = work.applicationWork('one')
    await settle(held.show('100', 'Word'))
    app.foreground = false
    await vi.advanceTimersByTimeAsync(300)
    app.escaped = true
    await vi.advanceTimersByTimeAsync(100)
    expect(held.signal.aborted).toBe(true)
    expect(overlay.overlayStatus().state).toBe('idle')
  })
  it('is not re-ordered or re-revealed by further document calls', async () => {
    const held = work.applicationWork('one')
    await settle(held.show('100', 'Word'))
    const shows = frames.length
    await held.show('100', 'Word')
    await held.show('100', 'Word')
    expect(frames).toHaveLength(shows)
    app.foreground = false
    await vi.advanceTimersByTimeAsync(300)
    await held.show('100', 'Word')
    expect(hides()).toHaveLength(0)
    expect(overlay.overlayStatus().application?.visible).toBe(true)
    expect(pill().showInactive).toHaveBeenCalledTimes(1)
  })
})
