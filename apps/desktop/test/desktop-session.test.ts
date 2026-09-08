import { beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ settings: vi.fn(), engines: vi.fn() }))
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }))
vi.mock('../src/renderer/src/api.js', () => ({ api: {
  desktopAvailable: async () => true, desktopBindings: async () => [], desktopControlStatus: async () => ({ state: 'idle' }),
  settingsGet: fake.settings, engines: fake.engines,
} }))
import { refreshDesktop, useDesktopSession } from '../src/renderer/src/lib/desktopSession.js'

beforeEach(() => {
  vi.clearAllMocks()
  fake.settings.mockResolvedValue({ defaultEngine: 'claude' })
  fake.engines.mockResolvedValue([{ id: 'claude', installed: true, loggedIn: true, desktopToolIsolation: true }])
})
describe('selected connection desktop capability', () => {
  it('enables control only for the explicitly supported selected connection', async () => {
    await refreshDesktop()
    expect(useDesktopSession().controlSupported).toBe(true)
  })
  it.each([undefined, false])('fails closed for missing or false capability (%s)', async (desktopToolIsolation) => {
    fake.engines.mockResolvedValue([{ id: 'claude', installed: true, loggedIn: true, desktopToolIsolation }])
    await refreshDesktop()
    expect(useDesktopSession().controlSupported).toBe(false)
  })
  it('does not substitute another supported connection for the selected unsupported one', async () => {
    fake.settings.mockResolvedValue({ defaultEngine: 'codex' })
    fake.engines.mockResolvedValue([
      { id: 'claude', installed: true, loggedIn: true, desktopToolIsolation: true },
      { id: 'codex', installed: true, loggedIn: true, desktopToolIsolation: false },
    ])
    await refreshDesktop()
    expect(useDesktopSession().controlSupported).toBe(false)
  })
  it('clears stale capability when the connection or settings cannot be read', async () => {
    await refreshDesktop()
    fake.settings.mockRejectedValueOnce(new Error('Settings unavailable'))
    await refreshDesktop()
    expect(useDesktopSession()).toMatchObject({ controlSupported: false, error: 'Settings unavailable' })
  })
  it('does not enable a disconnected engine even when its implementation supports isolation', async () => {
    fake.engines.mockResolvedValue([{ id: 'claude', installed: true, loggedIn: false, desktopToolIsolation: true }])
    await refreshDesktop()
    expect(useDesktopSession().controlSupported).toBe(false)
  })
  it('does not let a stale selected-engine read restore capability after a switch', async () => {
    let resolve!: (value: { defaultEngine: string }) => void
    fake.settings.mockReturnValueOnce(new Promise<{ defaultEngine: string }>((done) => { resolve = done }))
    const old = refreshDesktop()
    await vi.waitFor(() => expect(fake.settings).toHaveBeenCalledOnce())
    fake.settings.mockResolvedValue({ defaultEngine: 'codex' })
    await refreshDesktop()
    expect(useDesktopSession().controlSupported).toBe(false)
    resolve({ defaultEngine: 'claude' })
    await old
    expect(useDesktopSession().controlSupported).toBe(false)
  })
})
