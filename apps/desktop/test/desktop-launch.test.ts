import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ preview: vi.fn(), bind: vi.fn(), launched: vi.fn(), request: vi.fn(), close: vi.fn(), remember: vi.fn(), flog: vi.fn() }))
vi.mock('../src/main/work-preview.js', () => ({ showWorkPreview: fake.preview }))
vi.mock('electron', () => ({ screen: {} }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: class { request = fake.request; close = fake.close } }))
vi.mock('../src/main/desktop-access.js', () => ({ desktopForeground: async () => ({ pid: 99, title: "Previous" }), bindDesktopForLane: fake.bind, rememberLaunchedApp: fake.launched, rememberOpenedForeground: fake.remember, setDesktopReleaseHook: vi.fn(), desktopChanged: vi.fn(), desktopBinding: vi.fn() }))
vi.mock('../src/main/desktop-overlay.js', () => ({ hideControlOverlay: vi.fn() }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: vi.fn() }))
vi.mock('../src/main/flog.js', () => ({ flog: fake.flog }))
import { endDesktopTurn, openDesktopApp, setDesktopEngineResolver, stopDesktopFromUi } from '../src/main/desktop-control.js'

beforeEach(() => {
  endDesktopTurn('bot-launch')
  vi.clearAllMocks()
  setDesktopEngineResolver(async () => ({ id: 'claude', desktopToolIsolation: true }))
  fake.bind.mockRejectedValue(new Error('No open window matches "calculator".'))
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

it('launch binds the lane to the launched window and shows the preview', async () => {
  const binding = { window: '123', pid: 42 }
  fake.bind.mockRejectedValueOnce(new Error('No open window matches "YouTube".')).mockResolvedValueOnce(binding)
  fake.request.mockResolvedValue({ opened: true, windowVerified: true, window: '123', pid: 42, hidden: false, hiddenFallback: 'chromium-does-not-draw-hidden' })
  const result = JSON.parse(await openDesktopApp('bot-launch', 'YouTube'))
  expect(fake.bind).toHaveBeenLastCalledWith('bot-launch', { app: 'window:123:0' })
  expect(fake.launched).toHaveBeenCalledWith('bot-launch', 42)
  expect(fake.preview).toHaveBeenCalledWith(binding)
  expect(result.hint).toContain('This app stays open behind the current window (Chrome-family apps do not draw while hidden); the person sees it in the preview card.')
})
