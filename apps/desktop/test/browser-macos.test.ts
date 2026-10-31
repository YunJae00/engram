import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { launchMacBrowser, macBrowserScale } from '../src/main/browser-macos.js'
import type { BrowserContext } from 'playwright-core'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), connect: vi.fn(), create: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('playwright-core', () => ({ chromium: { connectOverCDP: mocks.connect } }))
vi.mock('../src/main/browser-window-page.js', () => ({ createWindowPage: mocks.create }))
let child: EventEmitter & { stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.clearAllMocks()
  child = Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn() })
  mocks.spawn.mockReturnValue(child)
})
afterEach(() => { child.stderr.destroy(); vi.useRealTimers() })
const started = () => child.stderr.write('DevTools listening on ws://127.0.0.1:9222/devtools/browser/owned\n')

it('starts without a normal window and closes only its owned browser on disconnect', async () => {
  const context = new EventEmitter()
  const browser = Object.assign(new EventEmitter(), { contexts: () => [context], close: vi.fn(async () => {}) })
  mocks.connect.mockResolvedValue(browser)
  mocks.create.mockResolvedValue({})
  const opening = launchMacBrowser('/owned-profile', { executablePath: '/Chrome', args: ['--remote-debugging-port=9222'], viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })
  started()
  expect(await opening).toBe(context)
  const args = mocks.spawn.mock.calls[0][1] as string[]
  expect(args).toContain('--no-startup-window')
  expect(args).toContain('--user-data-dir=/owned-profile')
  expect(macBrowserScale(context as BrowserContext)).toBe(2)
  expect(args.filter(arg => arg.startsWith('--remote-debugging-port='))).toEqual(['--remote-debugging-port=9222'])
  expect(mocks.create).toHaveBeenCalledWith(context, { width: 1280, height: 860 })
  browser.emit('disconnected')
  expect(child.kill).toHaveBeenCalledOnce()
})

it('does not leave Chrome running when its first background target fails', async () => {
  const context = new EventEmitter()
  mocks.connect.mockResolvedValue(Object.assign(new EventEmitter(), { contexts: () => [context] }))
  mocks.create.mockRejectedValue(new Error('Target could not be created'))
  const opening = launchMacBrowser('/owned-profile', { executablePath: '/Chrome' })
  started()
  await expect(opening).rejects.toThrow('Target could not be created')
  expect(child.kill).toHaveBeenCalledOnce()
})

it('bounds startup and kills an owned browser that never exposes a local endpoint', async () => {
  vi.useFakeTimers()
  const opening = launchMacBrowser('/owned-profile', { executablePath: '/Chrome' })
  const failure = expect(opening).rejects.toThrow('within 30 seconds')
  child.stderr.write('DevTools listening on ws://remote.example/devtools/browser/untrusted\n')
  await vi.advanceTimersByTimeAsync(30_000)
  await failure
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(child.kill).toHaveBeenCalledOnce()
})
