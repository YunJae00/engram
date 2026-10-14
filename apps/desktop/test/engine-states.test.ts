import { afterEach, expect, it, vi } from 'vitest'

const detect = vi.hoisted(() => vi.fn())
const send = vi.hoisted(() => vi.fn())
const prime = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('core', async importOriginal => ({ ...await importOriginal<typeof import('core')>(), createEngine: (id: string) => ({ id, detect: () => detect(id) }) }))
vi.mock('electron', () => ({ app: { getPath: () => `${process.cwd()}/tmp/engine-states` }, BrowserWindow: { getAllWindows: () => [{ webContents: { id: 1, send } }] } }))
vi.mock('../src/main/desktop-overlay.js', () => ({ overlayWindowIds: () => [] }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => ({ defaultEngine: 'codex', aiSelections: { filing: { engine: 'codex', model: 'chosen', effort: 'high' } } }) }))
vi.mock('../src/main/work-map-job.js', () => ({ primeWorkMap: prime }))
import { engineStates, refreshEngines, synchronizeFilingProbe, type VaultContext } from '../src/main/vault.js'
import { revalidateEngines } from '../src/main/engine-health.js'

afterEach(() => { vi.unstubAllEnvs(); detect.mockReset(); send.mockReset(); prime.mockReset() })

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

it('repairs a stale empty filing engine list and suppresses unchanged probe broadcasts', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  detect.mockResolvedValue({ installed: true, loggedIn: true })
  const ctx = { engines: [] } as unknown as VaultContext
  await synchronizeFilingProbe(ctx, await engineStates(['codex']))
  expect(ctx.engines.map(engine => engine.id)).toEqual(['codex'])
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0][1]).toMatchObject({ type: 'engines:changed', engines: [{ id: 'codex', installed: true, loggedIn: true }] })
  await revalidateEngines(ctx, false, false)
  expect(send).toHaveBeenCalledOnce()
  detect.mockResolvedValue({ installed: true, loggedIn: false })
  await revalidateEngines(ctx, false, false)
  expect(ctx.engines).toEqual([])
  expect(send).toHaveBeenCalledTimes(2)
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

it('starts initial filing after connection without holding up engine readiness', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  detect.mockResolvedValue({ installed: true, loggedIn: true })
  let finish!: () => void
  prime.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const ctx = { engines: [] } as unknown as VaultContext
  await revalidateEngines(ctx)
  expect(ctx.engines).toHaveLength(1)
  expect(send).toHaveBeenCalledOnce()
  await vi.waitFor(() => expect(prime).toHaveBeenCalledExactlyOnceWith(ctx))
  finish()
  await revalidateEngines(ctx)
  expect(prime).toHaveBeenCalledOnce()
})

it('does not prepare personal context before an AI account is connected', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  detect.mockResolvedValue({ installed: true, loggedIn: false })
  const ctx = { engines: [] } as unknown as VaultContext
  await revalidateEngines(ctx)
  expect(ctx.engines).toHaveLength(0)
  expect(prime).not.toHaveBeenCalled()
})

it('never restores an old connected result after a newer signed-out refresh', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  let finishOld!: (state: { installed: boolean; loggedIn: boolean }) => void
  detect.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockResolvedValueOnce({ installed: true, loggedIn: false })
  const ctx = { engines: [] } as unknown as VaultContext
  const old = refreshEngines(ctx)
  await vi.waitFor(() => expect(detect).toHaveBeenCalledOnce())
  await refreshEngines(ctx)
  expect(ctx.engines).toEqual([])
  finishOld({ installed: true, loggedIn: true })
  await old
  expect(ctx.engines).toEqual([])
})

it('a model-only save does not upgrade unconfirmed auth into a connected verdict', async () => {
  vi.stubEnv('ENGRAM_ENGINE', 'auto')
  const ctx = { engines: [{ id: 'codex', authConfirmed: false }] } as unknown as VaultContext
  await refreshEngines(ctx, true)
  expect((ctx.engines[0] as { authConfirmed?: boolean }).authConfirmed).toBe(false)
  expect(detect).not.toHaveBeenCalled()
})
