import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

interface HostDouble { closed: boolean; close(): void; revoke(): void }
const fake = vi.hoisted(() => ({ hosts: [] as HostDouble[], inspect: vi.fn(), sources: vi.fn(), dialog: vi.fn(), release: vi.fn(), changed: vi.fn() }))
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  desktopCapturer: { getSources: fake.sources }, dialog: { showMessageBox: fake.dialog },
}))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: fake.changed }))
vi.mock('../src/main/desktop-host.js', () => ({
  DesktopHost: class {
    closed = false
    static available() { return true }
    constructor(private changed: (reason: string) => void) { fake.hosts.push(this) }
    request = fake.inspect
    close() { if (!this.closed) { this.closed = true; this.changed('The connection closed') } }
    revoke() { this.changed('Mouse input returned control to the user') }
  },
}))
import { chooseDesktop, closeDesktopAccess, desktopBinding, desktopBindings, setDesktopOwner, setDesktopReadAccess, setDesktopReleaseHook } from '../src/main/desktop-access.js'

const lane = 'bot-one'
beforeEach(() => {
  closeDesktopAccess()
  vi.clearAllMocks()
  fake.hosts = []
  fake.inspect.mockResolvedValue({ pid: 200, title: 'Selected fixture' })
  fake.sources.mockResolvedValue([{ id: 'window:100:0', name: 'Selected fixture' }])
  fake.dialog.mockResolvedValue({ response: 1 })
  setDesktopOwner({ on: vi.fn(), isDestroyed: () => false, webContents: { on: vi.fn() } } as unknown as BrowserWindow)
  setDesktopReleaseHook(fake.release)
})

describe('desktop binding terminal connection state', () => {
  it('publishes a live selected connection as reconnect-free', async () => {
    expect(await chooseDesktop(lane, 'window:100:0')).toMatchObject({ lane, readable: false, stopped: false })
    expect(desktopBindings()).toMatchObject([{ lane, stopped: false }])
  })

  it('keeps ordinary physical revocation resumable with fresh consent', async () => {
    await chooseDesktop(lane, 'window:100:0')
    await setDesktopReadAccess(lane, true)
    fake.hosts[0]!.revoke()
    expect(desktopBindings()).toMatchObject([{ readable: false, stopped: false }])
    expect(fake.release).toHaveBeenLastCalledWith(lane, 'Mouse input returned control to the user')
    expect(await setDesktopReadAccess(lane, true)).toMatchObject({ readable: true, stopped: false })
    expect(fake.dialog).toHaveBeenCalledTimes(2)
  })

  it('marks terminal closure and rejects new read consent until reconnect', async () => {
    await chooseDesktop(lane, 'window:100:0')
    await setDesktopReadAccess(lane, true)
    fake.hosts[0]!.close()
    expect(desktopBindings()).toMatchObject([{ readable: false, stopped: true }])
    await expect(setDesktopReadAccess(lane, true)).rejects.toThrow('Reconnect the app window to continue.')
    expect(fake.dialog).toHaveBeenCalledOnce()
  })

  it('reconnects through a fresh host and ignores callbacks from the old connection', async () => {
    await chooseDesktop(lane, 'window:100:0')
    const old = fake.hosts[0]!
    old.close()
    expect(await chooseDesktop(lane, 'window:100:0')).toMatchObject({ readable: false, stopped: false })
    old.revoke()
    expect(desktopBindings()).toMatchObject([{ readable: false, stopped: false }])
    expect(fake.hosts).toHaveLength(2)
    expect(await setDesktopReadAccess(lane, true)).toMatchObject({ readable: true, stopped: false })
  })

  it('does not install a connection that closed before window selection completed', async () => {
    fake.inspect.mockImplementationOnce(async () => {
      fake.hosts[0]!.close()
      return { pid: 200, title: 'Selected fixture' }
    })
    await expect(chooseDesktop(lane, 'window:100:0')).rejects.toThrow('Reconnect the app window to continue.')
    expect(desktopBinding(lane)).toBeUndefined()
  })
})
