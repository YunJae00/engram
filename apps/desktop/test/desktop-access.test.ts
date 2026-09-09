import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

interface HostDouble { closed: boolean; close(): void; revoke(reason?: string): void }
const fake = vi.hoisted(() => ({
  hosts: [] as HostDouble[], request: vi.fn(), sources: vi.fn(), release: vi.fn(), changed: vi.fn(),
  windows: [] as { window: string; pid: number; title: string; minimized: boolean; foreground?: boolean }[],
}))
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
import { bindDesktopForLane, chooseDesktop, closeDesktopAccess, desktopBinding, desktopBindings, desktopWindows, setDesktopOwner, setDesktopReadAccess, setDesktopReleaseHook } from '../src/main/desktop-access.js'

const lane = 'bot-one'
const other = 'bot-two'
beforeEach(() => {
  closeDesktopAccess()
  vi.clearAllMocks()
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

  it('lists windows for the comet with the one in front marked, without keeping a host open', async () => {
    expect(await desktopWindows()).toEqual([
      { id: 'window:100:0', name: 'Quarterly workbook - Excel', foreground: true },
      { id: 'window:101:0', name: 'Planning notes - Notepad' },
      { id: 'window:102:0', name: 'Old sheet - Excel' },
    ])
    expect(fake.hosts).toHaveLength(1)
    expect(fake.hosts[0]!.closed).toBe(true)
  })
})

describe('the connection through hands and closures', () => {
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
