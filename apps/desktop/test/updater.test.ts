import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mock = vi.hoisted(() => ({ packaged: true, open: vi.fn(), check: vi.fn(), download: vi.fn(), install: vi.fn() }))
vi.mock('electron', () => ({ app: { get isPackaged() { return mock.packaged }, getVersion: () => '0.8.24' }, shell: { openExternal: mock.open } }))
vi.mock('../src/main/flog.js', () => ({ flog: vi.fn() }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: Object.assign(new EventEmitter(), {
  checkForUpdates: mock.check, downloadUpdate: mock.download, quitAndInstall: mock.install,
  autoDownload: true, autoInstallOnAppQuit: true,
}) } }))

let updater: typeof import('../src/main/updater.js')
let engine: (typeof import('electron-updater'))['default']['autoUpdater']
let latest: string
let finish: () => void
let reject: (err: Error) => void
let notify: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers()
  mock.packaged = true
  engine = (await import('electron-updater')).default.autoUpdater
  engine.removeAllListeners()
  updater = await import('../src/main/updater.js')
  latest = '0.8.25'
  mock.check.mockImplementation(async () => {
    engine.emit('update-available', { version: latest })
    return { updateInfo: { version: latest }, isUpdateAvailable: true }
  })
  mock.download.mockImplementation(() => {
    const version = latest
    return new Promise<string[]>((resolve, fail) => {
      finish = () => { engine.emit('update-downloaded', { version }); resolve([]) }
      reject = fail
    })
  })
  notify = vi.fn()
  updater.startUpdater(notify)
})
afterEach(() => { vi.useRealTimers() })
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }

it('replaces a downloaded release and refuses restart until the latest bytes arrive', async () => {
  await updater.checkForUpdatesNow(); finish(); await settle()
  expect(updater.updateStateNow().state).toBe('ready')
  expect(engine.autoInstallOnAppQuit).toBe(true)
  latest = '0.8.26'
  const quitting = vi.fn()
  expect(await updater.installUpdateNow(quitting)).toEqual({ started: false, reason: 'downloading' })
  expect(mock.download).toHaveBeenCalledTimes(2)
  expect(engine.autoInstallOnAppQuit).toBe(false)
  expect(notify).toHaveBeenLastCalledWith({ state: 'downloading', version: latest, percent: 0, selfInstalls: true })
  expect(quitting).not.toHaveBeenCalled()
  expect(mock.install).not.toHaveBeenCalled()
  finish(); await settle()
  expect(await updater.installUpdateNow(quitting)).toEqual({ started: true })
  expect(quitting).toHaveBeenCalledOnce()
  expect(mock.install).toHaveBeenCalledWith(false, true)
})

it('waits for an older in-flight download and never announces it as ready', async () => {
  await updater.checkForUpdatesNow()
  latest = '0.8.26'
  await updater.checkForUpdatesNow()
  expect(mock.download).toHaveBeenCalledTimes(1)
  finish(); await settle()
  expect(mock.download).toHaveBeenCalledTimes(2)
  expect(notify.mock.calls.some(([state]) => state.state === 'ready')).toBe(false)
  expect(engine.autoInstallOnAppQuit).toBe(false)
  finish(); await settle()
  expect(updater.updateStateNow()).toMatchObject({ state: 'ready', version: latest })
})

it('reports a failed replacement download and retries without installing stale bytes', async () => {
  await updater.checkForUpdatesNow(); finish(); await settle()
  latest = '0.8.26'
  await updater.checkForUpdatesNow(); reject(new Error('network unavailable')); await settle()
  expect(updater.updateStateNow()).toMatchObject({ state: 'error', version: latest })
  expect(engine.autoInstallOnAppQuit).toBe(false)
  await updater.checkForUpdatesNow()
  expect(mock.download).toHaveBeenCalledTimes(3)
  expect(updater.updateStateNow().state).toBe('downloading')
})

it('does not quit if the freshness check fails or the release was withdrawn', async () => {
  await updater.checkForUpdatesNow(); finish(); await settle()
  mock.check.mockRejectedValueOnce(new Error('offline'))
  expect(await updater.installUpdateNow(vi.fn())).toEqual({ started: false, reason: 'error' })
  mock.check.mockImplementationOnce(async () => { engine.emit('update-not-available'); return { isUpdateAvailable: false } })
  expect(await updater.installUpdateNow(vi.fn())).toEqual({ started: false, reason: 'current' })
  expect(mock.install).not.toHaveBeenCalled()
  expect(engine.autoInstallOnAppQuit).toBe(false)
})

it('does not check or download in a development build', async () => {
  mock.packaged = false
  expect(await updater.checkForUpdatesNow()).toMatchObject({ state: 'checking-unavailable' })
  expect(mock.check).not.toHaveBeenCalled()
  expect(mock.download).not.toHaveBeenCalled()
})
