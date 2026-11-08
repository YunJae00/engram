import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { DesktopHost } from '../src/main/desktop-host.js'

interface HostDouble { closed: boolean; close(): void; revoke(reason?: string): void }
const fake = vi.hoisted(() => ({
  pids: [] as number[],
  hosts: [] as HostDouble[], request: vi.fn(), sources: vi.fn(), release: vi.fn(), changed: vi.fn(),
  windows: [] as { bounds?: { x: number }; window: string; pid: number; title: string; minimized: boolean; foreground?: boolean }[],
}))
vi.mock('../src/main/agent-browser.js', () => ({ agentBrowserPids: async () => fake.pids }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: fake.sources },
}))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fake.changed }))
vi.mock('../src/main/desktop-host.js', () => ({
  DesktopHost: class {
    closed = false
    static available() { return true }
    constructor(private changed: (reason: string) => void) { fake.hosts.push(this) }
    request = fake.request
    close() { if (!this.closed) { this.closed = true; this.changed('The connection closed') } }
    revoke(reason = 'Mouse input returned control to the user') { this.changed(reason) }
  },
}))
import { rememberLaunchedApp, rememberHiddenApp, refreshHiddenApp, showDesktopApp, releaseDesktop, rememberOpenedForeground, bindDesktopForLane, chooseDesktop, closeDesktopAccess, desktopBinding, desktopBindings, desktopVisible, desktopWindows, keptOut, setDesktopAppsOff, setDesktopLaneWorking, setDesktopOwner, setDesktopReadAccess, setDesktopReleaseHook, closeCatalogHost } from '../src/main/desktop-access.js'

const lane = 'bot-one'
const other = 'bot-two'
beforeEach(() => {
  closeDesktopAccess()
  setDesktopAppsOff([])
  vi.clearAllMocks()
  fake.pids = []
  fake.hosts = []
  fake.windows = [
    { window: '100', pid: 200, title: 'Quarterly workbook - Excel', minimized: false, foreground: true },
    { window: '101', pid: 201, title: 'Planning notes - Notepad', minimized: false },
    { window: '102', pid: 202, title: 'Old sheet - Excel', minimized: true },
  ]
  fake.request.mockImplementation(async (method: string) => {
    if (method === 'listWindows') return { windows: fake.windows }
    if (method === 'inspectWindow') return { pid: 200, title: 'Selected fixture' }
    return { ok: true }
  })
  fake.sources.mockResolvedValue([{ id: 'window:100:0', name: 'Selected fixture' }])
  setDesktopOwner({ on: vi.fn(), isDestroyed: () => false, webContents: { on: vi.fn() } } as unknown as BrowserWindow)
  setDesktopReleaseHook(fake.release)
})

// The comet chooses the window. The app in front is the default; a word from a
// title names another; the person is never shown a list to pick from.
describe('binding the app the comet needs', () => {
  it('turning an app off releases existing access and rejects both selection paths', async () => {
    await bindDesktopForLane(lane, { app: 'Excel' })
    setDesktopAppsOff(['Excel'])
    expect(desktopBinding(lane)).toBeUndefined()
    await expect(bindDesktopForLane(lane, { app: 'Excel' })).rejects.toThrow('out of Engram')
    fake.request.mockResolvedValueOnce({ pid: 200, title: 'Quarterly workbook - Excel' })
    await expect(chooseDesktop(lane, 'window:100:0')).rejects.toThrow('turned off')
  })
  it('takes the window in front, readable at once, on one host', async () => {
    const binding = await bindDesktopForLane(lane)
    expect(binding).toMatchObject({ lane, window: '100', pid: 200, name: 'Quarterly workbook - Excel', readable: true, stopped: false })
    expect(fake.hosts).toHaveLength(1)
    expect(desktopBindings()).toMatchObject([{ lane, readable: true }])
  })

  it('names an app by a word from its title and prefers a window that is not minimized', async () => {
    const binding = await bindDesktopForLane(lane, { app: 'notepad' })
    expect(binding).toMatchObject({ window: '101', name: 'Planning notes - Notepad' })
    expect((await bindDesktopForLane(lane, { app: 'Excel' })).window).toBe('100')
  })

  it('requires an exact identity for overlapping app titles instead of following the foreground', async () => {
    fake.windows.push({ window: '103', pid: 203, title: 'Other workbook - Excel', minimized: false })
    await expect(bindDesktopForLane(lane, { app: 'Excel' })).rejects.toThrow('window:103:0')
    expect((await bindDesktopForLane(lane, { app: 'window:103:0' })).window).toBe('103')
    expect((await bindDesktopForLane(lane, { app: 'Quarterly workbook - Excel' })).window).toBe('100')
  })

  it('says which app is missing instead of guessing', async () => {
    await expect(bindDesktopForLane(lane, { app: 'Figma' })).rejects.toThrow('No open window matches "Figma"')
    fake.windows = fake.windows.map((one) => ({ ...one, foreground: false }))
    await expect(bindDesktopForLane(lane)).rejects.toThrow('No app window is in front')
    expect(desktopBinding(lane)).toBeUndefined()
    expect(fake.hosts.every((host) => host.closed)).toBe(true)
  })

  it('keeps the host when the same window is asked for again and swaps it for another', async () => {
    const first = await bindDesktopForLane(lane)
    expect(await bindDesktopForLane(lane)).toBe(first)
    expect(await bindDesktopForLane(lane, { app: 'Excel' })).toBe(first)
    const second = await bindDesktopForLane(lane, { app: 'Notepad' })
    expect(second).not.toBe(first)
    expect(second.host).toBe(first.host)
    expect(fake.release).not.toHaveBeenCalled()
    expect(second.revision).toBeGreaterThan(first.revision)
  })

  it('does not let two chats share one window', async () => {
    await bindDesktopForLane(lane)
    await expect(bindDesktopForLane(other, { app: 'Quarterly' })).rejects.toThrow('belongs to another chat')
  })

  it('hands a window over when the chat holding it is not working', async () => {
    await bindDesktopForLane(lane)
    setDesktopLaneWorking(held => held !== lane)
    try {
      expect((await bindDesktopForLane(other, { app: 'Quarterly' })).lane).toBe(other)
      expect(desktopBinding(lane)).toBeUndefined()
    } finally { setDesktopLaneWorking(() => true) }
  })

  it('refuses an app the person keeps out, matched by the name its windows end with', async () => {
    setDesktopAppsOff(['Excel'])
    try {
      expect(keptOut('Quarterly workbook - Excel')).toBe('excel')
      expect(keptOut('Excel tips - Browser')).toBeUndefined()
      await expect(bindDesktopForLane(lane, { app: 'Quarterly' })).rejects.toThrow('out of Engram')
      expect((await bindDesktopForLane(lane, { app: 'Planning' })).name).toBe('Planning notes - Notepad')
    } finally { setDesktopAppsOff([]) }
  })

  it('lists windows for the comet with the one in front marked, keeping one catalog helper warm until it is closed', async () => {
    expect(await desktopWindows()).toEqual([
      { id: 'window:100:0', name: 'Quarterly workbook - Excel', foreground: true },
      { id: 'window:101:0', name: 'Planning notes - Notepad' },
      { id: 'window:102:0', name: 'Old sheet - Excel' },
    ])
    expect(fake.hosts).toHaveLength(1)
    expect(fake.hosts[0]!.closed).toBe(false)
    await desktopWindows()
    expect(fake.hosts).toHaveLength(1)
    closeCatalogHost()
    expect(fake.hosts[0]!.closed).toBe(true)
  })
})

describe('the connection through hands and closures', () => {
  it('does not let a closed connection reserve a window against a new chat', async () => {
    const first = await bindDesktopForLane(lane)
    first.host.close()
    const next = await bindDesktopForLane(other)
    expect(next.window).toBe(first.window)
    expect(next.host).not.toBe(first.host)
    expect(next.host.closed).toBe(false)
    await expect(bindDesktopForLane(lane)).rejects.toThrow('belongs to another chat')
  })

  it('lists windows after a previous chat connection closed without reconnecting that chat', async () => {
    const binding = await bindDesktopForLane(lane)
    binding.host.close()
    await expect(desktopWindows()).resolves.toHaveLength(3)
    expect(fake.hosts).toHaveLength(2)
    expect(fake.request.mock.contexts.at(-1)).toBe(fake.hosts[1])
    expect(fake.hosts[1]!.closed).toBe(false)
    expect(desktopBinding(lane)).toBe(binding)
    expect(binding.stopped).toBe(true)
  })

  it('reuses a live connection instead of an earlier closed connection for window listing', async () => {
    const first = await bindDesktopForLane(lane)
    first.host.close()
    const second = await bindDesktopForLane(other, { app: 'Notepad' })
    await expect(desktopWindows()).resolves.toHaveLength(3)
    expect(fake.request.mock.contexts.at(-1)).toBe(second.host)
    expect(second.host.closed).toBe(false)
    expect(fake.hosts).toHaveLength(2)
  })

  it('a hand on the mouse reaches control but leaves the app readable', async () => {
    await bindDesktopForLane(lane)
    fake.hosts[0]!.revoke()
    expect(fake.release).toHaveBeenLastCalledWith(lane, 'Mouse input returned control to the user')
    expect(desktopBindings()).toMatchObject([{ readable: true, stopped: false }])
  })

  it('a closed host is terminal until the comet binds again', async () => {
    await bindDesktopForLane(lane)
    fake.hosts[0]!.close()
    expect(desktopBindings()).toMatchObject([{ stopped: true }])
    const fresh = await bindDesktopForLane(lane)
    expect(fresh.stopped).toBe(false)
    expect(fake.hosts).toHaveLength(2)
  })

  it('the manual route still works without any dialog', async () => {
    expect(await chooseDesktop(lane, 'window:100:0')).toMatchObject({ lane, readable: false, stopped: false })
    expect(await setDesktopReadAccess(lane, true)).toMatchObject({ readable: true })
    fake.hosts[0]!.close()
    await expect(setDesktopReadAccess(lane, true)).rejects.toThrow('Reconnect the app window to continue.')
  })

  it('does not install a connection that closed before window selection completed', async () => {
    fake.request.mockImplementationOnce(async () => {
      fake.hosts[0]!.close()
      return { pid: 200, title: 'Selected fixture' }
    })
    await expect(chooseDesktop(lane, 'window:100:0')).rejects.toThrow('Reconnect the app window to continue.')
    expect(desktopBinding(lane)).toBeUndefined()
  })
})

it('restores the launch foreground only at the first binding of the opened process', async () => {
  rememberOpenedForeground(lane, { pid: 201, previousFrontPid: 99 })
  await bindDesktopForLane(lane, { app: 'Excel' })
  expect(fake.request.mock.calls.some(([method]) => method === 'inspectWindow')).toBe(false)
  await bindDesktopForLane(lane, { app: 'Notepad' })
  expect(fake.request).toHaveBeenCalledWith('inspectWindow', { window: '101', pid: 201, restoreForegroundPid: 99 })
  fake.request.mockClear()
  await bindDesktopForLane(lane, { app: 'Notepad' })
  expect(fake.request.mock.calls.some(([method]) => method === 'inspectWindow')).toBe(false)
})

it('unminimizes only the selected minimized window during binding', async () => {
  fake.windows.push({ window: '103', pid: 202, title: 'Other minimized sheet - Excel', minimized: true })
  const binding = await bindDesktopForLane(lane, { app: 'window:102:0' })
  expect(binding.window).toBe('102')
  expect(fake.request.mock.calls.filter(([method]) => method === 'inspectWindow')).toEqual([
    ['inspectWindow', { window: '102', pid: 202, unminimize: true }],
  ])
})

it('restores only apps launched hidden, on release and on Show app', async () => {
  const attached = await bindDesktopForLane(lane)
  releaseDesktop(lane)
  expect(fake.request).not.toHaveBeenCalledWith('unhideApp', expect.anything())
  const launched = await bindDesktopForLane(lane)
  const launcher = attached.host
  rememberHiddenApp(lane, launched.pid, launcher)
  launched.hiddenByEngram = launched.pid
  await showDesktopApp(lane)
  expect(fake.request).toHaveBeenCalledWith('unhideApp', { pid: launched.pid, activate: true })
  expect(launched.hiddenByEngram).toBeUndefined()
  fake.request.mockClear()
  rememberHiddenApp(lane, launched.pid, launcher)
  releaseDesktop(lane)
  await Promise.resolve()
  expect(fake.request).toHaveBeenCalledWith('unhideApp', { pid: launched.pid, activate: false })
})
it('clears hidden ownership when the person unhides and leaves their app visible on release', async () => {
  const held = await bindDesktopForLane(lane)
  rememberHiddenApp(lane, held.pid, held.host)
  held.hiddenByEngram = held.pid
  fake.request.mockResolvedValueOnce({ hidden: false })
  await refreshHiddenApp(held)
  expect(held.hiddenByEngram).toBeUndefined()
  releaseDesktop(lane)
  expect(fake.request).not.toHaveBeenCalledWith('unhideApp', expect.anything())
})
it('awaits restoration of a hidden launch even before its first app_read binding', async () => {
  const held = await bindDesktopForLane(lane)
  rememberHiddenApp(other, 201, held.host)
  await closeDesktopAccess()
  expect(fake.request).toHaveBeenCalledWith('unhideApp', { pid: 201, activate: false })
})

it('keeps a newly launched app hidden when it replaces an older app binding in the lane', async () => {
  const older = await bindDesktopForLane(lane)
  rememberHiddenApp(lane, 201, older.host)
  const next = await bindDesktopForLane(lane, { app: 'Notepad' })
  expect(next.hiddenByEngram).toBe(201)
  expect(fake.request).not.toHaveBeenCalledWith('unhideApp', expect.anything())
  await closeDesktopAccess()
})

it('restores an unbound hidden launch when the lane reads a different app instead', async () => {
  await bindDesktopForLane(lane)
  rememberHiddenApp(lane, 201, new DesktopHost(() => undefined))
  await bindDesktopForLane(lane, { app: 'Excel' })
  expect(fake.request).toHaveBeenCalledWith('unhideApp', { pid: 201, activate: false })
  await closeDesktopAccess()
})

it('excludes agent Chrome pids while binding the YouTube PWA', async () => {
  fake.pids = [300, 301]
  fake.windows = [
    { window: '110', pid: 250, title: 'Home — YouTube', minimized: false },
    { window: '111', pid: 300, title: '(3) YouTube - Google Chrome', minimized: false },
    { window: '112', pid: 301, title: 'YouTube - Google Chrome', minimized: false },
  ]
  expect((await bindDesktopForLane(lane, { app: 'YouTube' })).window).toBe('110')
  expect(await desktopWindows()).toHaveLength(1)
})
it('follows a new main window only for the app this lane launched', async () => {
  const original = await bindDesktopForLane(lane)
  fake.windows.push({ window: '103', pid: 200, title: 'New workbook - Excel', minimized: false })
  fake.request.mockImplementation(async (method: string) => method === 'inspectWindow' ? { mainWindow: '103' } : { windows: fake.windows })
  expect(await refreshHiddenApp(original)).toBe(original)
  rememberLaunchedApp(other, 200)
  expect(await refreshHiddenApp(original)).toBe(original)
  rememberLaunchedApp(lane, 201)
  expect(await refreshHiddenApp(original)).toBe(original)
  rememberLaunchedApp(lane, 200)
  const next = await refreshHiddenApp(original)
  expect(next).not.toBe(original)
  expect(next).toMatchObject({ window: '103', pid: 200, name: 'New workbook - Excel' })
  expect(desktopBinding(lane)).toBe(next)
  expect(fake.changed).toHaveBeenCalledWith({ type: 'desktop:changed' })
})

it('excludes offscreen browser windows when their pid is unknown', async () => {
  fake.windows.push({ window: '110', pid: 300, title: 'YouTube - Google Chrome', minimized: false, bounds: { x: -4000 } })
  expect(await desktopWindows()).toHaveLength(3)
  await expect(bindDesktopForLane(lane, { app: 'YouTube' })).rejects.toThrow('No open window matches')
})

it('reports the minimized owner window as not visible and restores visibility', () => {
  const listeners = new Map<string, () => void>()
  let minimized = false
  setDesktopOwner({
    on: (name: string, listener: () => void) => listeners.set(name, listener),
    isDestroyed: () => false, isVisible: () => true, isMinimized: () => minimized, webContents: { on: vi.fn() },
  } as unknown as BrowserWindow)
  expect(desktopVisible()).toBe(true)
  minimized = true
  listeners.get('minimize')!()
  expect(fake.changed).toHaveBeenLastCalledWith({ type: 'desktop:visibility', visible: false })
  expect(desktopVisible()).toBe(false)
  minimized = false
  listeners.get('restore')!()
  expect(fake.changed).toHaveBeenLastCalledWith({ type: 'desktop:visibility', visible: true })
  expect(desktopVisible()).toBe(true)
})
