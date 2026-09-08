import { beforeEach, describe, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ settings: vi.fn(), engines: vi.fn(), bindings: vi.fn(), access: vi.fn() }))
vi.mock('react', () => ({ useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }))
vi.mock('../src/renderer/src/api.js', () => ({ api: {
  desktopAvailable: async () => true, desktopBindings: fake.bindings, desktopReadAccess: fake.access, desktopControlStatus: async () => ({ state: 'idle' }),
  settingsGet: fake.settings, engines: fake.engines,
} }))
import { refreshDesktop, selectDesktopSurface, useDesktopSession } from '../src/renderer/src/lib/desktopSession.js'

beforeEach(() => {
  vi.clearAllMocks()
  fake.bindings.mockResolvedValue([])
  fake.access.mockResolvedValue({})
  fake.settings.mockResolvedValue({ defaultEngine: 'claude' })
  fake.engines.mockResolvedValue([{ id: 'claude', installed: true, loggedIn: true, desktopToolIsolation: true }])
})
describe('selected connection desktop capability', () => {
  it('ends app access before switching to browser work', async () => {
    const lane = 'switch-browser'
    fake.bindings.mockResolvedValue([{ lane, readable: true }])
    await refreshDesktop()
    selectDesktopSurface(lane, 'computer')
    let resolve!: () => void
    fake.access.mockReturnValueOnce(new Promise<void>((done) => { resolve = done }))
    selectDesktopSurface(lane, 'browser')
    expect(fake.access).toHaveBeenCalledWith(lane, false)
    expect(useDesktopSession().surfaces[lane]).toBe('computer')
    resolve()
    await vi.waitFor(() => expect(useDesktopSession().surfaces[lane]).toBe('browser'))
  })
  it('keeps the selected surface when revocation fails', async () => {
    const lane = 'switch-fails'
    fake.bindings.mockResolvedValue([{ lane, readable: true }])
    await refreshDesktop()
    selectDesktopSurface(lane, 'computer')
    fake.access.mockRejectedValueOnce(new Error('Access could not stop'))
    selectDesktopSurface(lane, 'browser')
    await vi.waitFor(() => expect(useDesktopSession().error).toBe('Access could not stop'))
    expect(useDesktopSession().surfaces[lane]).toBe('computer')
  })
  it('does not overwrite a newer surface choice after delayed revocation', async () => {
    const lane = 'switch-race'
    fake.bindings.mockResolvedValue([{ lane, readable: true }])
    await refreshDesktop()
    let resolve!: () => void
    fake.access.mockReturnValueOnce(new Promise<void>((done) => { resolve = done }))
    selectDesktopSurface(lane, 'browser')
    selectDesktopSurface(lane, 'computer')
    resolve()
    await new Promise((done) => setTimeout(done, 0))
    expect(useDesktopSession().surfaces[lane]).toBe('computer')
  })
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
