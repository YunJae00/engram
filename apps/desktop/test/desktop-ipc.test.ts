import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

type Request = { frame: unknown; audioRequested?: boolean }
type Callback = (grant: Record<string, unknown>) => void
type IpcHandler = (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => unknown
const deps = vi.hoisted(() => ({
  owner: undefined as { webContents: { id: number; mainFrame: object; isDestroyed(): boolean } } | undefined,
  handlers: new Map<string, IpcHandler>(),
  visible: true,
  captureHandler: undefined as ((request: Request, callback: Callback) => void) | undefined,
  bindings: vi.fn(), capture: vi.fn(), choose: vi.fn(), windows: vi.fn(), observe: vi.fn(), release: vi.fn(), readAccess: vi.fn(),
}))
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: IpcHandler) => deps.handlers.set(name, handler) },
  session: { defaultSession: { setDisplayMediaRequestHandler: (handler: typeof deps.captureHandler) => { deps.captureHandler = handler } } },
}))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: { available: () => true } }))
vi.mock('../src/main/desktop-access.js', () => ({
  desktopOwner: () => deps.owner, desktopVisible: () => deps.visible, desktopBindings: deps.bindings, captureSource: deps.capture,
  chooseDesktop: deps.choose, desktopWindows: deps.windows, observeDesktop: deps.observe,
  releaseDesktop: deps.release, setDesktopReadAccess: deps.readAccess,
}))
import { allowDesktopCapture as capturePermission, registerDesktopIpc } from '../src/main/desktop-ipc.js'

let ownerId = 1
function sender() { return deps.owner!.webContents as unknown as WebContents }
function allowDesktopCapture(contents: WebContents | null, permission: string, details: { isMainFrame?: boolean; mediaTypes?: unknown } = { isMainFrame: true }) {
  return capturePermission(contents, permission, details)
}
function call(name: string, ...args: unknown[]) {
  return deps.handlers.get(name)!({ sender: deps.owner!.webContents, senderFrame: deps.owner!.webContents.mainFrame }, ...args)
}
function capture(request: Partial<Request> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve) => deps.captureHandler!({ frame: deps.owner!.webContents.mainFrame, audioRequested: false, ...request }, resolve))
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  deps.owner = { webContents: { id: ownerId++, mainFrame: {}, isDestroyed: () => false } }
  deps.handlers.clear()
  deps.visible = true
  deps.bindings.mockReturnValue([{ lane: 'bot-a', source: 'window:1:0', readable: false }])
  deps.capture.mockReset().mockResolvedValue({ id: 'window:1:0', name: 'App' })
  registerDesktopIpc()
})

describe('desktop IPC boundary', () => {
  it('does not start or finish a stream after the app is hidden', async () => {
    expect(call('desktop:visible')).toBe(true)
    call('desktop:prepare', 'bot-a')
    deps.visible = false
    expect(call('desktop:visible')).toBe(false)
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
    expect(() => call('desktop:prepare', 'bot-a')).toThrow('Show Engram')
    expect(await capture()).toEqual({})
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it('defaults to denying all capture and unrelated media permissions', async () => {
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
    expect(allowDesktopCapture(null, 'display-capture')).toBe(false)
    expect(await capture()).toEqual({})
    expect(deps.capture).not.toHaveBeenCalled()
    call('desktop:prepare', 'bot-a')
    for (const permission of ['media', 'microphone', 'camera', 'clipboard-read', 'geolocation']) expect(allowDesktopCapture(sender(), permission)).toBe(false)
  })

  it.each(['desktop:windows', 'desktop:choose', 'desktop:release', 'desktop:readAccess', 'desktop:observe', 'desktop:prepare'])('rejects %s from a different sender or a subframe', (name) => {
    const handler = deps.handlers.get(name)!
    expect(() => handler({ sender: { id: sender().id }, senderFrame: sender().mainFrame }, 'bot-a')).toThrow('main window')
    expect(() => handler({ sender: sender(), senderFrame: {} }, 'bot-a')).toThrow('main window')
    expect(deps.observe).not.toHaveBeenCalled()
    expect(deps.readAccess).not.toHaveBeenCalled()
  })

  it('exposes no mutation handler and forwards only the requested read-access lane', () => {
    expect(deps.handlers.has('desktop:act')).toBe(false)
    expect(deps.handlers.has('desktop:control')).toBe(false)
    call('desktop:readAccess', 'bot-a', true)
    expect(deps.readAccess).toHaveBeenCalledExactlyOnceWith('bot-a', true)
  })

  it('requires an existing selected lane before preparing capture', () => {
    expect(() => call('desktop:prepare', 'bot-other')).toThrow('Connect an app window')
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
  })

  it('grants one video capture for the selected lane and consumes it once', async () => {
    call('desktop:prepare', 'bot-a')
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(true)
    expect(() => call('desktop:prepare', 'bot-a')).toThrow('already starting')
    expect(await capture()).toEqual({ video: { id: 'window:1:0', name: 'App' } })
    expect(deps.capture).toHaveBeenCalledExactlyOnceWith('bot-a')
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
    expect(await capture()).toEqual({})
  })

  it('allows the legacy display request only with empty physical-device types and a main-frame grant', async () => {
    const details = { isMainFrame: true, mediaTypes: [] }
    expect(allowDesktopCapture(sender(), 'media', details)).toBe(false)
    call('desktop:prepare', 'bot-a')
    expect(allowDesktopCapture(sender(), 'media', details)).toBe(true)
    expect(allowDesktopCapture(null, 'media', details)).toBe(false)
    expect(allowDesktopCapture({ id: sender().id } as WebContents, 'media', details)).toBe(false)
    for (const mediaTypes of [undefined, null, 'video', {}, ['video'], ['audio'], ['video', 'audio'], ['unknown']]) {
      expect(allowDesktopCapture(sender(), 'media', { isMainFrame: true, mediaTypes })).toBe(false)
    }
    for (const isMainFrame of [undefined, false]) {
      expect(allowDesktopCapture(sender(), 'media', { isMainFrame, mediaTypes: [] })).toBe(false)
      expect(allowDesktopCapture(sender(), 'display-capture', { isMainFrame })).toBe(false)
    }
    expect(await capture()).toMatchObject({ video: { id: 'window:1:0' } })
    expect(allowDesktopCapture(sender(), 'media', details)).toBe(false)
  })

  it('expires legacy media permission together with its one-use display grant', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    call('desktop:prepare', 'bot-a')
    expect(allowDesktopCapture(sender(), 'media', { isMainFrame: true, mediaTypes: [] })).toBe(true)
    clock.mockReturnValue(11000)
    expect(allowDesktopCapture(sender(), 'media', { isMainFrame: true, mediaTypes: [] })).toBe(false)
  })

  it('never grants audio or an untrusted capture frame', async () => {
    call('desktop:prepare', 'bot-a')
    expect(await capture({ audioRequested: true })).toEqual({})
    expect(await capture({ frame: {} })).toEqual({})
    expect(deps.capture).not.toHaveBeenCalled()
    expect(allowDesktopCapture({ id: sender().id } as WebContents, 'display-capture')).toBe(false)
  })

  it('expires a pending capture grant', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    call('desktop:prepare', 'bot-a')
    clock.mockReturnValue(11001)
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
    expect(await capture()).toEqual({})
    expect(deps.capture).not.toHaveBeenCalled()
  })

  it('fails closed when the window disappears before its source is revalidated', async () => {
    call('desktop:prepare', 'bot-a')
    deps.capture.mockRejectedValue(new Error('Window disconnected'))
    expect(await capture()).toEqual({})
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
    expect(await capture()).toEqual({})
  })

  it('does not expose a prior main window grant after the owner changes', async () => {
    call('desktop:prepare', 'bot-a')
    const prior = sender()
    deps.owner = { webContents: { id: ownerId++, mainFrame: {}, isDestroyed: () => false } }
    expect(allowDesktopCapture(prior, 'display-capture')).toBe(false)
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
    expect(await capture()).toEqual({})
  })

  it('denies a source resolved after the requesting main window was replaced', async () => {
    call('desktop:prepare', 'bot-a')
    let resolve!: (source: Record<string, string>) => void
    deps.capture.mockReturnValue(new Promise((done) => { resolve = done }))
    const result = capture()
    deps.owner = { webContents: { id: ownerId++, mainFrame: {}, isDestroyed: () => false } }
    resolve({ id: 'window:1:0', name: 'App' })
    expect(await result).toEqual({})
  })

  it('denies a source resolved after the one-use grant expires', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    call('desktop:prepare', 'bot-a')
    let resolve!: (source: Record<string, string>) => void
    deps.capture.mockReturnValue(new Promise((done) => { resolve = done }))
    const result = capture()
    clock.mockReturnValue(11001)
    resolve({ id: 'window:1:0', name: 'App' })
    expect(await result).toEqual({})
  })

  it('cancels only the matching one-use grant without clearing a newer one', async () => {
    const first = call('desktop:prepare', 'bot-a')
    expect(typeof first).toBe('string')
    call('desktop:cancelCapture', first)
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
    const second = call('desktop:prepare', 'bot-a')
    expect(second).not.toBe(first)
    call('desktop:cancelCapture', first)
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(true)
    expect(await capture()).toMatchObject({ video: { id: 'window:1:0' } })
    call('desktop:cancelCapture', second)
    expect(allowDesktopCapture(sender(), 'display-capture')).toBe(false)
  })

  it('does not grant a different source if the selected lane changes while capture is pending', async () => {
    call('desktop:prepare', 'bot-a')
    deps.bindings.mockReturnValue([{ lane: 'bot-a', source: 'window:2:0', readable: false }])
    deps.capture.mockResolvedValue({ id: 'window:2:0', name: 'Other app' })
    expect(await capture()).toEqual({})
  })

  it('does not grant capture if the selected lane was disconnected', async () => {
    call('desktop:prepare', 'bot-a')
    deps.bindings.mockReturnValue([])
    expect(await capture()).toEqual({})
  })
})
