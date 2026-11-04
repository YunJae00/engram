import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ request: vi.fn(), close: vi.fn(), remember: vi.fn(), flog: vi.fn() }))
vi.mock('electron', () => ({ screen: {} }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: class { request = fake.request; close = fake.close } }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopForeground: async () => ({ pid: 99, title: "Previous" }), bindDesktopForLane: async () => { throw new Error('No open window matches "calculator".') }, rememberOpenedForeground: fake.remember, setDesktopReleaseHook: vi.fn(), desktopChanged: vi.fn(), desktopBinding: vi.fn() }))
vi.mock('../src/main/desktop-overlay.js', () => ({ hideControlOverlay: vi.fn() }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: fake.flog }))
import { endDesktopTurn, openDesktopApp, setDesktopEngineResolver, stopDesktopFromUi } from '../src/main/desktop-control.js'

beforeEach(() => {
  endDesktopTurn('bot-launch')
  vi.clearAllMocks()
  setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
  fake.request.mockResolvedValue({ requested: true, opened: true })
})

it('launches only through an isolated engine and requires observation afterward', async () => {
  expect(await openDesktopApp('bot-launch', 'calculator')).toContain('does not prove')
  expect(await openDesktopApp('bot-launch', 'calculator')).toContain('No app window was verified yet')
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
  const rejected = expect(pending).rejects.toThrow('Computer control stopped:')
  await vi.waitFor(() => expect(done).toBeTypeOf('function'))
  stopDesktopFromUi()
  expect(fake.close).toHaveBeenCalled()
  done()
  await rejected
  await expect(openDesktopApp('bot-launch', 'calculator')).rejects.toThrow('Computer control stopped:')
  expect(fake.request).toHaveBeenCalledOnce()
})

it('reports launch acceptance separately from window verification', async () => {
  endDesktopTurn('bot-launch')
  expect(JSON.parse(await openDesktopApp('bot-launch', 'calculator'))).toMatchObject({ opened: true, windowVerified: false })
})

it('records launch foreground restoration without retaining the prior app once restored', async () => {
  fake.request.mockResolvedValue({ requested: true, opened: true, pid: 42, previousFrontPid: 99, foregroundChanged: true, foregroundRestored: true })
  await openDesktopApp('bot-launch', 'calculator')
  expect(fake.remember).not.toHaveBeenCalled()
  expect(fake.flog).toHaveBeenCalledWith('harness', JSON.stringify({ kind: 'host', operation: 'foreground-restored', lane: 'bot-launch', tool: 'open_app' }))
})
it('retains the prior app for first binding only when the launch is still in front', async () => {
  fake.request.mockResolvedValue({ requested: true, opened: true, pid: 42, previousFrontPid: 99, foregroundChanged: true, foregroundRestored: false })
  await openDesktopApp('bot-launch', 'calculator')
  expect(fake.remember).toHaveBeenCalledWith('bot-launch', expect.objectContaining({ pid: 42, previousFrontPid: 99 }))
  fake.remember.mockClear(); fake.flog.mockClear()
  fake.request.mockResolvedValue({ requested: true, opened: true, pid: 43, previousFrontPid: 99, foregroundChanged: false, foregroundRestored: true, windowVerified: true })
  await openDesktopApp('bot-launch', 'calculator')
  expect(fake.remember).not.toHaveBeenCalled()
  expect(fake.flog).not.toHaveBeenCalledWith('harness', expect.stringContaining('foreground-restored'))
})
