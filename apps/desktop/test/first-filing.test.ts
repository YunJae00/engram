import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ filing: vi.fn(), outcome: vi.fn(), desk: vi.fn(), prime: vi.fn(), workMap: false, waits: [] as number[] }))
vi.mock('node:timers/promises', () => ({ setTimeout: (ms: number) => { fake.waits.push(ms); return new Promise(resolve => setImmediate(resolve)) } }))
vi.mock('core', async original => ({ ...await original<typeof import('core')>(), prepareInitialFiling: fake.filing, readWorkMap: async () => null, engineBackoff: { blockedMs: () => 0 } }))
vi.mock('../src/main/engine-health.js', () => ({ noteRunOutcome: fake.outcome, revalidateEngines: async () => undefined }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => ({ workMap: fake.workMap }) }))
vi.mock('../src/main/work-map-job.js', () => ({ primeWorkMap: fake.prime }))
vi.mock('../src/main/desk-sources.js', () => ({ refreshDeskNotes: fake.desk, withheldDeskNotes: async () => [] }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
import { startFirstFiling } from '../src/main/first-filing.js'

const done = { executed: 3, skipped: 0, failed: [], deferred: 0, noteIds: ['n-a', 'n-b', 'n-c'] }

beforeEach(() => { vi.unstubAllEnvs(); vi.stubEnv('ENGRAM_USERDATA', ''); fake.filing.mockReset(); fake.outcome.mockReset(); fake.desk.mockReset(); fake.prime.mockReset().mockResolvedValue(undefined); fake.workMap = false; fake.waits = [] })

async function vault() {
  await mkdir(resolve('tmp'), { recursive: true })
  const cache = join(await mkdtemp(resolve('tmp/first-filing-')), 'cache')
  await mkdir(cache, { recursive: true })
  return { paths: { cache }, engines: [{ id: 'mock' }] } as unknown as Parameters<typeof startFirstFiling>[0]
}

it('organizes what setup gathered once, in the background, and not again', async () => {
  const ctx = await vault()
  fake.filing.mockResolvedValue(done)
  const filed = vi.fn()
  const exclusive = vi.fn((_signal: AbortSignal, run: () => Promise<void>) => run())
  startFirstFiling(ctx, exclusive, new AbortController().signal, filed)
  await vi.waitFor(() => expect(filed).toHaveBeenCalledOnce())
  expect(fake.filing).toHaveBeenCalledWith(ctx.paths, ctx.engines, expect.objectContaining({ concurrency: 4, includeWorkMap: false }))
  expect(fake.desk).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(join(ctx.paths.cache, 'first-filing.json'), 'utf8'))).toHaveProperty('at')
  startFirstFiling(ctx, exclusive, new AbortController().signal, filed)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(exclusive).toHaveBeenCalledOnce()
})

it('keeps no marker when the filing was cut short, so it is tried again', async () => {
  const ctx = await vault()
  fake.filing.mockResolvedValue({ ...done, failed: ['n-b'] })
  const stop = new AbortController()
  const exclusive = vi.fn((_signal: AbortSignal, run: () => Promise<void>) => run())
  startFirstFiling(ctx, exclusive, stop.signal)
  await vi.waitFor(() => expect(fake.filing).toHaveBeenCalled())
  stop.abort()
  await expect(readFile(join(ctx.paths.cache, 'first-filing.json'), 'utf8')).rejects.toThrow()
})

it('leaves a probe or test profile alone', async () => {
  vi.stubEnv('ENGRAM_USERDATA', 'C:/somewhere')
  const exclusive = vi.fn()
  startFirstFiling(await vault(), exclusive, new AbortController().signal)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(exclusive).not.toHaveBeenCalled()
})

it('goes ahead at once without the work map when the map could not be made', async () => {
  fake.workMap = true
  fake.prime.mockRejectedValue(new Error('Command failed: powershell.exe'))
  fake.filing.mockResolvedValue(done)
  const ctx = await vault()
  const filed = vi.fn()
  startFirstFiling(ctx, (_signal, run) => run(), new AbortController().signal, filed)
  await vi.waitFor(() => expect(filed).toHaveBeenCalledOnce(), { timeout: 2000 })
  expect(fake.filing).toHaveBeenCalledWith(ctx.paths, ctx.engines, expect.objectContaining({ includeWorkMap: false }))
})

it('tries again within a minute when the first try could not start', async () => {
  fake.filing.mockRejectedValueOnce(new Error('no AI is connected yet')).mockResolvedValue(done)
  const filed = vi.fn()
  startFirstFiling(await vault(), (_signal, run) => run(), new AbortController().signal, filed)
  await vi.waitFor(() => expect(filed).toHaveBeenCalledOnce())
  expect(fake.waits).toEqual([30_000])
})
