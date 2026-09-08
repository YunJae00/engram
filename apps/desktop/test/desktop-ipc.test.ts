import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

interface Sender { id: number; mainFrame: object; isDestroyed(): boolean }
interface CaptureRequest { frame: object; audioRequested: boolean }
type CaptureHandler = (request: CaptureRequest, callback: (result: unknown) => void) => void
type IpcHandler = (event: { sender: Sender; senderFrame: object }, ...args: unknown[]) => unknown

const deps = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(), captureHandler: undefined as CaptureHandler | undefined,
  owner: undefined as { webContents: Sender } | undefined, visible: true,
  bindings: [] as { lane: string; source: string; name: string; readable: boolean }[],
  capture: vi.fn(), read: vi.fn(), start: vi.fn(), stop: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: IpcHandler) => deps.handlers.set(name, handler) },
  session: { defaultSession: { setDisplayMediaRequestHandler: (handler: CaptureHandler) => { deps.captureHandler = handler } } },
}))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: { available: () => true } }))
vi.mock('../src/main/desktop-access.js', () => ({
  captureSource: deps.capture, desktopOwner: () => deps.owner, desktopVisible: () => deps.visible,
  desktopBindings: () => deps.bindings, desktopWindows: async () => [],
  chooseDesktop: vi.fn(), releaseDesktop: vi.fn(), setDesktopReadAccess: vi.fn(),
}))
vi.mock('../src/main/desktop-control.js', () => ({
  desktopControlStatus: () => ({ state: 'idle' }), readControlledDesktop: deps.read,
  startDesktopControl: deps.start, stopDesktopFromUi: deps.stop, resumeDesktopControl: vi.fn(),
}))
vi.mock('../src/main/desktop-overlay.js', () => ({ overlayWindowIds: () => [], overlayStatus: () => ({ state: 'idle' }) }))

const lane = 'bot-first'
const source = { id: 'window:100:0', name: 'Editor' }
let sender: Sender
let ipc: typeof import('../src/main/desktop-ipc.js')

function call(name: string, ...args: unknown[]): unknown {
  return deps.handlers.get(name)!({ sender, senderFrame: sender.mainFrame }, ...args)
}
function prepare(): string { return call('desktop:prepare', lane) as string }
function capture(audioRequested = false) {
  const callback = vi.fn<(value: unknown) => void>()
  deps.captureHandler!({ frame: sender.mainFrame, audioRequested }, callback)
  return callback
}
async function flush(): Promise<void> { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(0)
  deps.handlers.clear()
  deps.captureHandler = undefined
  sender = { id: 1, mainFrame: {}, isDestroyed: vi.fn(() => false) }
  deps.owner = { webContents: sender }
  deps.visible = true
  deps.bindings = [{ lane, source: source.id, name: source.name, readable: false }]
  deps.capture.mockReset().mockResolvedValue(source)
  deps.read.mockReset().mockResolvedValue({ snapshot: 's' })
  deps.start.mockReset()
  deps.stop.mockReset()
  ipc = await import('../src/main/desktop-ipc.js')
  ipc.registerDesktopIpc()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('desktop IPC ownership and permissions', () => {
  it('accepts only the main frame of the designated owner', () => {
    const handler = deps.handlers.get('desktop:prepare')!
    expect(() => handler({ sender: { ...sender, id: 2 }, senderFrame: sender.mainFrame }, lane)).toThrow('main window')
    expect(() => handler({ sender, senderFrame: {} }, lane)).toThrow('main window')
    expect(typeof prepare()).toBe('string')
  })

  it('keeps renderer observation read-only and exposes no direct native action IPC', async () => {
    await call('desktop:observe', lane)
    expect(deps.read).toHaveBeenCalledExactlyOnceWith(lane)
    expect(deps.handlers.has('desktop:action')).toBe(false)
    expect(deps.handlers.has('desktop:bind')).toBe(false)
    call('desktop:controlStart', lane)
    call('desktop:controlStop')
    expect(deps.start).toHaveBeenCalledExactlyOnceWith(lane)
    expect(deps.stop).toHaveBeenCalledOnce()
  })

  it('grants temporary display-only permission only for a prepared visible owner frame', () => {
    const contents = sender as unknown as WebContents
    expect(ipc.allowDesktopCapture(contents, 'display-capture', { isMainFrame: true })).toBe(false)
    prepare()
    expect(ipc.allowDesktopCapture(contents, 'display-capture', { isMainFrame: true })).toBe(true)
    expect(ipc.allowDesktopCapture(contents, 'media', { isMainFrame: true, mediaTypes: [] })).toBe(true)
    for (const details of [{ isMainFrame: false }, {}, { isMainFrame: true, mediaTypes: ['audio'] }, { isMainFrame: true, mediaTypes: ['video'] }]) {
      expect(ipc.allowDesktopCapture(contents, 'media', details)).toBe(false)
    }
    expect(ipc.allowDesktopCapture(contents, 'camera', { isMainFrame: true })).toBe(false)
    expect(ipc.allowDesktopCapture(null, 'display-capture', { isMainFrame: true })).toBe(false)
    expect(ipc.allowDesktopCapture({ ...sender } as unknown as WebContents, 'display-capture', { isMainFrame: true })).toBe(false)
    deps.visible = false
    expect(ipc.allowDesktopCapture(contents, 'display-capture', { isMainFrame: true })).toBe(false)
  })

  it('refuses preparation without a visible app and selected source', () => {
    deps.visible = false
    expect(() => prepare()).toThrow('Show Engram')
    deps.visible = true
    deps.bindings = []
    expect(() => prepare()).toThrow('Connect an app window')
  })
})

describe('single-use selected-window capture', () => {
  it('denies audio, unprepared and foreign-frame capture without enumerating windows', () => {
    expect(capture()).toHaveBeenCalledWith({})
    prepare()
    expect(capture(true)).toHaveBeenCalledWith({})
    const callback = vi.fn()
    deps.captureHandler!({ frame: {}, audioRequested: false }, callback)
    expect(callback).toHaveBeenCalledWith({})
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it('serves only the selected source once and clears permission after settlement', async () => {
    prepare()
    const callback = capture()
    await flush()
    expect(callback).toHaveBeenCalledExactlyOnceWith({ video: source })
    expect(deps.capture).toHaveBeenCalledExactlyOnceWith(lane)
    expect(capture()).toHaveBeenCalledExactlyOnceWith({})
    expect(ipc.allowDesktopCapture(sender as unknown as WebContents, 'display-capture', { isMainFrame: true })).toBe(false)
  })

  it('does not allow a second capture to consume the same in-flight request', async () => {
    const gate = deferred<typeof source>()
    deps.capture.mockReturnValue(gate.promise)
    prepare()
    const first = capture(), second = capture()
    expect(second).toHaveBeenCalledExactlyOnceWith({})
    expect(deps.capture).toHaveBeenCalledOnce()
    gate.resolve(source)
    await flush()
    expect(first).toHaveBeenCalledExactlyOnceWith({ video: source })
  })

  it('honors cancellation before a request is consumed', () => {
    const token = prepare()
    call('desktop:cancelCapture', 'unrelated-token')
    expect(() => prepare()).toThrow('already starting')
    call('desktop:cancelCapture', token)
    expect(capture()).toHaveBeenCalledExactlyOnceWith({})
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it('honors cancellation while native source validation is pending', async () => {
    const gate = deferred<typeof source>()
    deps.capture.mockReturnValue(gate.promise)
    const token = prepare()
    const callback = capture()
    call('desktop:cancelCapture', token)
    gate.resolve(source)
    await flush()
    expect(callback).toHaveBeenCalledExactlyOnceWith({})
  })

  it('does not let a cancelled old completion consume or clear a newer capture request', async () => {
    const old = deferred<typeof source>(), fresh = deferred<typeof source>()
    deps.capture.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const oldToken = prepare()
    const first = capture()
    call('desktop:cancelCapture', oldToken)
    const newToken = prepare()
    expect(newToken).not.toBe(oldToken)
    const second = capture()
    old.resolve(source)
    await flush()
    expect(first).toHaveBeenCalledExactlyOnceWith({})
    expect(second).not.toHaveBeenCalled()
    expect(ipc.allowDesktopCapture(sender as unknown as WebContents, 'display-capture', { isMainFrame: true })).toBe(true)
    fresh.resolve(source)
    await flush()
    expect(second).toHaveBeenCalledExactlyOnceWith({ video: source })
  })

  it.each(['source', 'disconnect', 'owner', 'hidden', 'destroyed', 'frame', 'expiry'] as const)('refuses late capture after %s changes', async (change) => {
    const gate = deferred<typeof source>()
    deps.capture.mockReturnValue(gate.promise)
    prepare()
    const callback = capture()
    if (change === 'source') deps.bindings[0]!.source = 'window:101:0'
    else if (change === 'disconnect') deps.bindings = []
    else if (change === 'owner') deps.owner = { webContents: { ...sender, id: 2 } }
    else if (change === 'hidden') deps.visible = false
    else if (change === 'destroyed') vi.mocked(sender.isDestroyed).mockReturnValue(true)
    else if (change === 'frame') sender.mainFrame = {}
    else vi.setSystemTime(10_000)
    gate.resolve(source)
    await flush()
    expect(callback).toHaveBeenCalledExactlyOnceWith({})
  })

  it('rejects a different returned source even if the selected binding did not change', async () => {
    deps.capture.mockResolvedValue({ id: 'window:999:0', name: 'Unselected' })
    prepare()
    const callback = capture()
    await flush()
    expect(callback).toHaveBeenCalledExactlyOnceWith({})
  })

  it('expires capture at the exact deadline before dispatch', () => {
    prepare()
    vi.setSystemTime(10_000)
    expect(capture()).toHaveBeenCalledExactlyOnceWith({})
    expect(deps.capture).not.toHaveBeenCalled()
    expect(ipc.allowDesktopCapture(sender as unknown as WebContents, 'display-capture', { isMainFrame: true })).toBe(false)
  })

  it('settles a failed source lookup once and permits another explicit preparation', async () => {
    deps.capture.mockRejectedValue(new Error('Window ended'))
    prepare()
    const callback = capture()
    await flush()
    expect(callback).toHaveBeenCalledExactlyOnceWith({})
    expect(() => prepare()).not.toThrow()
  })
})
