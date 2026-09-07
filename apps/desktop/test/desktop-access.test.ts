import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { DesktopObservationDto } from '../src/shared/desktop.js'

const deps = vi.hoisted(() => ({
  available: vi.fn(), sources: vi.fn(), request: vi.fn(), dialog: vi.fn(), broadcast: vi.fn(),
  instances: [] as { request: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[],
  windows: [] as unknown[],
}))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => deps.windows },
  desktopCapturer: { getSources: deps.sources }, dialog: { showMessageBox: deps.dialog },
}))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: deps.broadcast }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: class {
  static available = deps.available
  request = vi.fn((method: string, args: Record<string, unknown>) => deps.request(method, args))
  close = vi.fn()
  constructor() { deps.instances.push(this) }
} }))
vi.mock('core', async () => import('../../../packages/core/src/desktop-tools.js'))

import { captureSource, chooseDesktop, closeDesktopAccess, desktopAgentTools, desktopBindings, desktopVisible, desktopWindows, observeDesktop, releaseDesktop, setDesktopReadAccess, setDesktopOwner } from '../src/main/desktop-access.js'

const lane = 'bot-a'
const observation: DesktopObservationDto = {
  snapshot: 's1', bounds: { x: 0, y: 0, width: 800, height: 600 },
  nodes: [{ id: 'e1', name: 'Save report', controlType: 'Button', bounds: { x: 0, y: 0, width: 100, height: 30 } }],
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function connect(id = 'a', window = '1', readable = false) {
  const binding = await chooseDesktop(`bot-${id}`, `window:${window}:0`)
  if (readable) await setDesktopReadAccess(`bot-${id}`, true)
  return binding
}

beforeEach(() => {
  closeDesktopAccess()
  vi.clearAllMocks()
  deps.instances.length = 0
  deps.available.mockReturnValue(true)
  const handle = Buffer.alloc(8); handle.writeBigUInt64LE(99n)
  const owner = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, on: vi.fn(), getNativeWindowHandle: () => handle, webContents: { on: vi.fn() } }
  deps.windows = [owner]
  setDesktopOwner(owner as unknown as BrowserWindow)
  deps.sources.mockResolvedValue([
    ...Array.from({ length: 6 }, (_, index) => ({ id: `window:${index + 1}:0`, name: `App ${index + 1}` })),
    { id: 'window:99:1', name: 'Engram' }, { id: 'screen:1:0', name: 'Entire screen' }, { id: 'invalid', name: 'Invalid' },
  ])
  deps.dialog.mockReset().mockResolvedValue({ response: 1 })
  deps.request.mockReset().mockImplementation(async (method: string, args: Record<string, unknown>) => {
    if (method === 'inspectWindow') return { pid: 100 + Number(args['window']), title: `App ${String(args['window'])}` }
    if (method === 'observe') return structuredClone(observation)
    throw new Error('Unsupported helper request')
  })
})
afterEach(() => closeDesktopAccess())

describe('desktop access scopes', () => {
  it('reports native visibility changes even if renderer visibility stays visible', () => {
    const handlers = new Map<string, () => void>()
    let shown = true
    let minimized = false
    const window = { isDestroyed: () => false, isVisible: () => shown, isMinimized: () => minimized, on: (event: string, callback: () => void) => handlers.set(event, callback), webContents: { on: vi.fn() } }
    setDesktopOwner(window as unknown as BrowserWindow)
    expect(desktopVisible()).toBe(true)
    shown = false
    handlers.get('hide')!()
    expect(deps.broadcast).toHaveBeenLastCalledWith({ type: 'desktop:visibility', visible: false })
    shown = true; minimized = true
    handlers.get('minimize')!()
    expect(desktopVisible()).toBe(false)
    minimized = false
    handlers.get('restore')!()
    expect(deps.broadcast).toHaveBeenLastCalledWith({ type: 'desktop:visibility', visible: true })
  })

  it('offers only external app windows, never screens or its own window', async () => {
    expect(await desktopWindows()).toEqual(Array.from({ length: 6 }, (_, index) => ({ id: `window:${index + 1}:0`, name: `App ${index + 1}` })))
    expect(deps.sources).toHaveBeenCalledWith({ types: ['window'], thumbnailSize: { width: 0, height: 0 } })
    deps.available.mockReturnValue(false)
    expect(await desktopWindows()).toEqual([])
  })

  it.each(['window:99:1', 'window:404:0', 'screen:1:0', 'invalid'])('rejects unavailable or broad source %s', async (source) => {
    await expect(chooseDesktop(lane, source)).rejects.toThrow(/no longer available|valid app window/)
    expect(deps.instances).toHaveLength(0)
    expect(desktopBindings()).toEqual([])
  })

  it.each(['', 'bot:a', 'bot-', 'bot-a/b', `bot-${'x'.repeat(141)}`])('rejects an invalid lane %s', async (id) => {
    await expect(chooseDesktop(id, 'window:1:0')).rejects.toThrow('valid chat')
    expect(deps.sources).not.toHaveBeenCalled()
  })

  it('rejects a non-string lane even when string coercion resembles a valid chat', async () => {
    await expect(chooseDesktop(['bot-a'] as unknown as string, 'window:1:0')).rejects.toThrow('valid chat')
    expect(deps.instances).toHaveLength(0)
  })

  it('keeps capture view-only until explicit app access approval', async () => {
    expect(await connect()).toMatchObject({ lane, source: 'window:1:0', readable: false })
    expect(await captureSource(lane)).toMatchObject({ id: 'window:1:0' })
    expect(desktopAgentTools(lane)).toEqual([])
    await expect(observeDesktop(lane)).rejects.toThrow('Enable AI read access')
    expect(deps.request.mock.calls.some(([method]) => method === 'observe')).toBe(false)
    await expect(captureSource('bot-other')).rejects.toThrow('Choose an app window')
  })

  it('binds each lane to its own window and process', async () => {
    await connect('a', '1', true); await connect('b', '2', true)
    await observeDesktop('bot-b'); await observeDesktop('bot-a')
    expect(deps.request).toHaveBeenCalledWith('observe', { window: '2', pid: 102 })
    expect(deps.request).toHaveBeenCalledWith('observe', { window: '1', pid: 101 })
    expect(desktopAgentTools('bot-other')).toEqual([])
    expect(deps.instances).toHaveLength(2)
  })

  it('allows four distinct windows and replacing an existing lane at capacity', async () => {
    for (let i = 1; i <= 4; i++) await connect(String(i), String(i))
    await expect(connect('5', '5')).rejects.toThrow('four')
    await connect('1', '5')
    expect(desktopBindings()).toHaveLength(4)
    expect(desktopBindings().find((item) => item.lane === 'bot-1')?.source).toBe('window:5:0')
    expect(deps.instances[0]!.close).toHaveBeenCalledOnce()
  })

  it('can observe four selected windows concurrently without crossing lanes', async () => {
    for (let i = 1; i <= 4; i++) await connect(String(i), String(i), true)
    const gate = deferred<void>()
    deps.request.mockClear().mockImplementation(async (_method: string, args: Record<string, unknown>) => {
      await gate.promise
      return { ...observation, snapshot: `s${String(args['window'])}` }
    })
    const requests = Promise.all(Array.from({ length: 4 }, (_, i) => observeDesktop(`bot-${i + 1}`)))
    await vi.waitFor(() => expect(deps.request).toHaveBeenCalledTimes(4))
    expect(deps.request.mock.calls.map(([, args]) => args)).toEqual(Array.from({ length: 4 }, (_, i) => ({ window: String(i + 1), pid: i + 101 })))
    gate.resolve()
    expect((await requests).map((item) => item.snapshot)).toEqual(['s1', 's2', 's3', 's4'])
    expect(deps.instances).toHaveLength(4)
  })

  it('rejects sharing the same window with another lane', async () => {
    await connect()
    await expect(connect('b', '1')).rejects.toThrow('already belongs')
    expect(desktopBindings()).toHaveLength(1)
  })

  it('rechecks duplicate ownership after concurrent enumeration', async () => {
    const gate = deferred<{ pid: number; title: string }>()
    deps.request.mockReturnValue(gate.promise)
    const results = Promise.allSettled([connect('a', '1'), connect('b', '1')])
    await vi.waitFor(() => expect(deps.request).toHaveBeenCalledTimes(2))
    gate.resolve({ pid: 101, title: 'App 1' })
    expect((await results).filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(desktopBindings()).toHaveLength(1)
    expect(deps.instances.filter((host) => host.close.mock.calls.length > 0)).toHaveLength(1)
  })

  it('rechecks the four-window cap after concurrent enumeration', async () => {
    const gate = deferred<void>()
    deps.request.mockImplementation(async (_method: string, args: Record<string, unknown>) => {
      await gate.promise
      return { pid: 100 + Number(args['window']), title: 'App' }
    })
    const results = Promise.allSettled(Array.from({ length: 5 }, (_, i) => connect(String(i), String(i + 1))))
    await vi.waitFor(() => expect(deps.request).toHaveBeenCalledTimes(5))
    gate.resolve()
    expect((await results).filter((result) => result.status === 'fulfilled')).toHaveLength(4)
    expect(desktopBindings()).toHaveLength(4)
  })
})

describe('desktop authorization', () => {
  it('keeps access off when permission is declined or the argument is not boolean', async () => {
    await connect()
    deps.dialog.mockResolvedValue({ response: 0 })
    await expect(setDesktopReadAccess(lane, true)).rejects.toThrow('not enabled')
    await expect(setDesktopReadAccess(lane, 'true' as unknown as boolean)).rejects.toThrow('explicitly')
    expect(desktopBindings()[0]!.readable).toBe(false)
    expect(deps.dialog).toHaveBeenCalledOnce()
  })

  it('does not enable a disconnected window after a delayed permission reply', async () => {
    await connect()
    const gate = deferred<{ response: number }>()
    deps.dialog.mockReturnValue(gate.promise)
    const request = setDesktopReadAccess(lane, true)
    releaseDesktop(lane)
    gate.resolve({ response: 1 })
    await expect(request).rejects.toThrow()
    expect(desktopBindings()).toEqual([])
  })

  it('does not undo revocation when an earlier permission reply arrives', async () => {
    await connect()
    const gate = deferred<{ response: number }>()
    deps.dialog.mockReturnValue(gate.promise)
    const request = setDesktopReadAccess(lane, true)
    await setDesktopReadAccess(lane, false)
    gate.resolve({ response: 1 })
    await expect(request).rejects.toThrow()
    expect(desktopBindings()[0]?.readable ?? false).toBe(false)
  })

  it('does not reconnect a window after all access was closed during selection', async () => {
    const gate = deferred<{ pid: number; title: string }>()
    deps.request.mockReturnValue(gate.promise)
    const request = connect()
    await vi.waitFor(() => expect(deps.request).toHaveBeenCalledOnce())
    closeDesktopAccess()
    gate.resolve({ pid: 101, title: 'App 1' })
    await expect(request).rejects.toThrow()
    expect(desktopBindings()).toEqual([])
  })

  it('does not finish a pending selection after that lane was disconnected', async () => {
    const gate = deferred<{ pid: number; title: string }>()
    deps.request.mockReturnValue(gate.promise)
    const request = connect()
    await vi.waitFor(() => expect(deps.request).toHaveBeenCalledOnce())
    releaseDesktop(lane)
    gate.resolve({ pid: 101, title: 'App 1' })
    await expect(request).rejects.toThrow()
    expect(desktopBindings()).toEqual([])
  })

  it('refuses late read results and previously created tools after revocation', async () => {
    await connect('a', '1', true)
    const [read] = desktopAgentTools(lane)
    const gate = deferred<DesktopObservationDto>()
    deps.request.mockReturnValue(gate.promise)
    const request = observeDesktop(lane)
    await setDesktopReadAccess(lane, false)
    gate.resolve(observation)
    await expect(request).rejects.toThrow('ended')
    await expect(read!.run({}, { task: 'read' })).rejects.toThrow()
    expect(desktopAgentTools(lane)).toEqual([])
    expect(deps.instances[0]!.close).not.toHaveBeenCalled()
  })

  it('offers only reading and preserves live capture when read access is disabled', async () => {
    await connect('a', '1', true)
    expect(desktopAgentTools(lane).map((tool) => tool.name)).toEqual(['read_desktop'])
    await setDesktopReadAccess(lane, false)
    expect(deps.instances[0]!.close).not.toHaveBeenCalled()
    expect(await captureSource(lane)).toMatchObject({ id: 'window:1:0' })
    await setDesktopReadAccess(lane, true)
    expect(await observeDesktop(lane)).toEqual(observation)
    expect(deps.dialog).toHaveBeenCalledTimes(2)
    expect(deps.request.mock.calls.every(([method]) => method === 'inspectWindow' || method === 'observe')).toBe(true)
  })

  it('explains plaintext AI reading and excludes app mutations in consent', async () => {
    await connect('a', '1', true)
    expect(deps.dialog.mock.calls[0]![1]).toMatchObject({
      title: 'AI read access', message: 'Allow this chat to read App 1?',
      detail: expect.stringContaining('sent as plain text to your connected AI'),
      defaultId: 0, cancelId: 0,
    })
    expect(deps.dialog.mock.calls[0]![1].detail).toContain('cannot click, edit, scroll or type')
  })

  it('does not expose stale observations when access is revoked and then enabled again', async () => {
    await connect('a', '1', true)
    const gate = deferred<DesktopObservationDto>()
    deps.request.mockReturnValueOnce(gate.promise)
    const result = observeDesktop(lane)
    await setDesktopReadAccess(lane, false)
    await setDesktopReadAccess(lane, true)
    gate.resolve(observation)
    await expect(result).rejects.toThrow('ended')
    expect(await observeDesktop(lane)).toEqual(observation)
  })

  it('suppresses observations cancelled while the helper is reading without breaking capture', async () => {
    await connect('a', '1', true)
    const controller = new AbortController()
    const gate = deferred<DesktopObservationDto>()
    deps.request.mockReturnValueOnce(gate.promise)
    const result = observeDesktop(lane, controller.signal)
    controller.abort(new Error('Stopped'))
    gate.resolve(observation)
    await expect(result).rejects.toThrow('Stopped')
    expect(await captureSource(lane)).toMatchObject({ id: 'window:1:0' })
    expect(deps.instances[0]!.close).not.toHaveBeenCalled()
  })

  it('pauses access if the observation helper connection fails', async () => {
    await connect('a', '1', true)
    deps.request.mockRejectedValue(new Error('The app-sharing connection closed. Reconnect the window to continue.'))
    await expect(observeDesktop(lane)).rejects.toThrow('connection closed')
    expect(desktopBindings()[0]?.readable ?? false).toBe(false)
    expect(desktopAgentTools(lane)).toEqual([])
    expect(deps.instances[0]!.close).toHaveBeenCalledOnce()
    await expect(setDesktopReadAccess(lane, true)).rejects.toThrow('Choose the app window again')
  })
})
