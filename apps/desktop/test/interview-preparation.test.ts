import { beforeEach, expect, it, vi } from 'vitest'
import type { VaultContext } from '../src/main/vault.js'

const fake = vi.hoisted(() => ({ map: vi.fn(), prime: vi.fn(), settings: vi.fn(), filing: vi.fn(), outcome: vi.fn(), blocked: vi.fn() }))
vi.mock('core', async original => ({ ...await original<typeof import('core')>(), readWorkMap: fake.map, prepareInitialFiling: fake.filing, engineBackoff: { blockedMs: fake.blocked } }))
vi.mock('../src/main/work-map-job.js', () => ({ primeWorkMap: fake.prime }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: fake.settings }))
vi.mock('../src/main/engine-health.js', () => ({ noteRunOutcome: fake.outcome }))
import { prepareInterviewContext } from '../src/main/interview-preparation.js'

const ctx = { paths: {}, engines: [{ id: 'mock' }] } as unknown as VaultContext
const report = { executed: 2, skipped: 0, failed: [], deferred: 0, noteIds: ['n-prepared'] }
beforeEach(() => {
  vi.unstubAllEnvs(); vi.clearAllMocks()
  fake.settings.mockReset().mockResolvedValue({ workMap: true })
  fake.map.mockReset().mockResolvedValue({ places: [{ work: true }] })
  fake.prime.mockReset().mockResolvedValue(undefined)
  fake.filing.mockReset().mockResolvedValue(report)
  fake.blocked.mockReset().mockReturnValue(0)
})

it('prepares the map then a finite pass with real progress and returns its membership', async () => {
  const progress = vi.fn(), abort = new AbortController()
  fake.filing.mockImplementationOnce(async (_paths, _engines, options) => {
    expect(fake.prime).toHaveBeenCalledOnce()
    expect(options).toMatchObject({ signal: abort.signal, includeWorkMap: true, concurrency: 1 })
    options.onProgress(1, 2, 'organize')
    return report
  })
  expect(await prepareInterviewContext(ctx, abort.signal, progress)).toEqual(['n-prepared'])
  expect(progress.mock.calls).toEqual([[{ phase: 'mapping' }], [{ phase: 'filing', stage: 'organize', completed: 1, total: 2 }]])
  expect(fake.outcome).toHaveBeenCalledWith(ctx, report, ctx.engines[0])
})

it('does not read or prepare the map when learning is off', async () => {
  fake.settings.mockResolvedValue({ workMap: false })
  await prepareInterviewContext(ctx, new AbortController().signal, vi.fn())
  expect(fake.prime).not.toHaveBeenCalled(); expect(fake.map).not.toHaveBeenCalled()
  expect(fake.filing.mock.calls[0]![2]).toMatchObject({ includeWorkMap: false })
})

it('stops before filing when a real map could not be classified', async () => {
  fake.map.mockResolvedValue({ places: [{}] })
  await expect(prepareInterviewContext(ctx, new AbortController().signal, vi.fn())).rejects.toThrow('map is not ready')
  expect(fake.filing).not.toHaveBeenCalled()
})

it('keeps known places usable when another place has uncertain relevance', async () => {
  fake.map.mockResolvedValue({ places: [{ work: true }, {}] })
  expect(await prepareInterviewContext(ctx, new AbortController().signal, vi.fn())).toEqual(['n-prepared'])
})

it('cancels waiting for a shared map without canceling the map itself', async () => {
  const abort = new AbortController()
  let finish!: () => void
  fake.prime.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))
  const pending = prepareInterviewContext(ctx, abort.signal, vi.fn())
  const rejected = expect(pending).rejects.toThrow()
  await vi.waitFor(() => expect(fake.prime).toHaveBeenCalledOnce())
  abort.abort(); await rejected; finish()
  expect(fake.filing).not.toHaveBeenCalled()
})

it.each([
  { ...report, deferred: 1 },
  { ...report, failed: [{ kind: 'J2', inputKey: 'test', error: 'unavailable' }] },
  { ...report, haltReason: 'quota' },
  { ...report, haltReason: 'auth' },
])('never reports failed or deferred preparation as ready', async partial => {
  fake.filing.mockResolvedValue(partial)
  await expect(prepareInterviewContext(ctx, new AbortController().signal, vi.fn())).rejects.toThrow()
  expect(fake.outcome).toHaveBeenCalled()
})

it('does not spend usage when the engine is absent or cooling down', async () => {
  await expect(prepareInterviewContext({ ...ctx, engines: [] }, new AbortController().signal, vi.fn())).rejects.toThrow('Connect')
  fake.blocked.mockReturnValue(1000)
  await expect(prepareInterviewContext(ctx, new AbortController().signal, vi.fn())).rejects.toThrow('temporarily')
  expect(fake.prime).not.toHaveBeenCalled(); expect(fake.filing).not.toHaveBeenCalled()
})
