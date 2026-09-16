import { afterEach, expect, it, vi } from 'vitest'

const detect = vi.hoisted(() => vi.fn())
const send = vi.hoisted(() => vi.fn())
vi.mock('core', async importOriginal => ({ ...await importOriginal<typeof import('core')>(), createEngine: (id: string) => ({ id, detect: () => detect(id) }) }))
vi.mock('electron', () => ({ app: { getPath: () => `${process.cwd()}/tmp/engine-states` }, BrowserWindow: { getAllWindows: () => [{ webContents: { id: 1, send } }] } }))
vi.mock('../src/main/desktop-overlay.js', () => ({ overlayWindowIds: () => [] }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => ({ defaultEngine: 'codex', aiSelections: { filing: { engine: 'codex', model: 'chosen', effort: 'high' } } }) }))
import { engineStates, refreshEngines, type VaultContext } from '../src/main/vault.js'
import { revalidateEngines } from '../src/main/engine-health.js'

afterEach(() => { vi.unstubAllEnvs(); detect.mockReset(); send.mockReset() })

it('checks only the requested provider without waiting for the other runtime', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  detect.mockImplementation((id: string) => id === 'codex'
    ? Promise.resolve({ installed: true, loggedIn: true })
    : new Promise(() => {}))
  expect(await engineStates(['codex'])).toEqual([{ id: 'codex', installed: true, loggedIn: true }])
  expect(detect).toHaveBeenCalledExactlyOnceWith('codex')
})

it('still checks both providers for the connection settings screen', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  detect.mockResolvedValue({ installed: true, loggedIn: false })
  expect((await engineStates()).map(state => state.id).sort()).toEqual(['claude', 'codex'])
})

it('changing a model on the connected filing provider does not launch another auth probe', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  detect.mockResolvedValue({ installed: true, loggedIn: true })
  const ctx = { engines: [{ id: 'codex' }] } as VaultContext
  await refreshEngines(ctx, true)
  expect(ctx.engines).toHaveLength(1)
  expect(detect).not.toHaveBeenCalled()
  await refreshEngines(ctx)
  expect(detect).toHaveBeenCalledExactlyOnceWith('codex')
})

it('does not trigger a picker probe cascade after a model-only save but still broadcasts detection', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  detect.mockResolvedValue({ installed: true, loggedIn: true })
  const ctx = { engines: [{ id: 'codex' }] } as VaultContext
  await revalidateEngines(ctx, true)
  expect(send).not.toHaveBeenCalled()
  expect(detect).not.toHaveBeenCalled()
  await revalidateEngines(ctx)
  expect(send).toHaveBeenCalledTimes(1)
  expect(detect).toHaveBeenCalledExactlyOnceWith('codex')
})
