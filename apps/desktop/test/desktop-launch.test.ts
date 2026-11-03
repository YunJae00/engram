import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn(), remember: vi.fn(), flog: vi.fn() }))
vi.mock('electron', () => ({ screen: {} }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: class { request = fake.request; close = fake.close } }))
vi.mock('../src/main/desktop-access.js', () => ({ rememberOpenedForeground: fake.remember, setDesktopReleaseHook: vi.fn(), desktopChanged: vi.fn(), desktopBinding: vi.fn() }))
vi.mock('../src/main/desktop-overlay.js', () => ({ hideControlOverlay: vi.fn() }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: fake.flog }))
import { endDesktopTurn, openDesktopApp, setDesktopEngineResolver, stopDesktopFromUi } from '../src/main/desktop-control.js'

beforeEach(() => {
  endDesktopTurn('bot-launch')
  vi.clearAllMocks()
  setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
  fake.request.mockResolvedValue({ requested: true })
})

it('launches only through an isolated engine and requires observation afterward', async () => {
  expect(await openDesktopApp('bot-launch', 'calculator')).toContain('does not prove')
  expect(await openDesktopApp('bot-launch', 'calculator')).toContain('foreground control requires an approval card')
  expect(fake.request).toHaveBeenCalledWith('openApp', { app: 'calculator' })
  expect(fake.close).toHaveBeenCalledTimes(2)
  setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: false }))
  await expect(openDesktopApp('bot-launch', 'calculator')).rejects.toThrow()
  expect(fake.request).toHaveBeenCalledTimes(2)
})

it('closes pending launch on Stop and refuses later launches in that turn', async () => {
  let done!: () => void
  fake.request.mockImplementation(() => new Promise<void>((resolve) => { done = resolve }))
  const pending = openDesktopApp('bot-launch', 'calculator')
  const rejected = expect(pending).rejects.toThrow('cancelled for this turn')
  await vi.waitFor(() => expect(done).toBeTypeOf('function'))
  stopDesktopFromUi()
  expect(fake.close).toHaveBeenCalled()
  done()
  await rejected
  await expect(openDesktopApp('bot-launch', 'calculator')).rejects.toThrow('cancelled for this turn')
  expect(fake.request).toHaveBeenCalledOnce()
})

it('reports launch acceptance separately from window verification', async () => {
  endDesktopTurn('bot-launch')
  expect(JSON.parse(await openDesktopApp('bot-launch', 'calculator'))).toMatchObject({ opened: true, windowVerified: false })
})

it('records launch foreground restoration and retains the prior app for first binding', async () => {
  fake.request.mockResolvedValue({ requested: true, pid: 42, previousFrontPid: 99, foregroundRestored: true })
  await openDesktopApp('bot-launch', 'calculator')
  expect(fake.remember).toHaveBeenCalledWith('bot-launch', expect.objectContaining({ pid: 42, previousFrontPid: 99 }))
  expect(fake.flog).toHaveBeenCalledWith('harness', JSON.stringify({ kind: 'host', operation: 'foreground-restored', lane: 'bot-launch', tool: 'open_app' }))
})
