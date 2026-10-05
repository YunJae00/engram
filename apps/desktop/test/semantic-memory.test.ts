import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { VaultContext } from '../src/main/vault.js'

const fake = vi.hoisted(() => ({
  free: 0, footprint: 0.4e9, loads: 0, closes: 0,
  notes: [] as Array<{ front: { id: string; status: string; type: string; derived_from: string[] }; body: string }>,
  embed: vi.fn(),
}))
vi.mock('node:os', () => ({ default: { freemem: () => fake.free } }))
vi.mock('node:fs', () => ({ existsSync: () => false }))
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/test', getAppPath: () => '/test' }, ipcMain: {}, powerMonitor: {} }))
vi.mock('../src/main/ipc.js', () => ({ broadcast: vi.fn(), isLibrarianBusy: () => false }))
vi.mock('../src/main/memory-fabric.js', () => ({ fabricAfterIndex: vi.fn() }))
vi.mock('../src/main/embedding-assets.js', () => ({ embeddingAssets: async () => '/test/models' }))
vi.mock('../src/main/embedding-client.js', () => ({ EmbeddingClient: class {
  ready = Promise.resolve()
  closed = false
  footprint = fake.footprint
  constructor() { fake.loads++; fake.free -= this.footprint }
  embed(texts: string[]) { return fake.embed(texts) }
  async close() {
    if (this.closed) return
    this.closed = true; fake.closes++; fake.free += this.footprint
  }
} }))
vi.mock('core', () => ({
  loadVectorIndex: async () => null,
  emptyVectorIndex: () => ({ ids: [] }),
  staleForEmbedding: (notes: typeof fake.notes, index: { ids: string[] }) => notes.filter(note => !index.ids.includes(note.front.id)),
  embedTextOf: (note: { body: string }) => note.body,
  embedDigestOf: (note: { body: string }) => note.body,
  applyEmbeddings: (index: { ids: string[] }, rows: Array<{ id: string }>) => ({ ids: [...new Set([...index.ids, ...rows.map(row => row.id)])] }),
  saveVectorIndex: vi.fn(),
  cosineTopK: (index: { ids: string[] }) => index.ids.map(id => ({ id, score: 1 })),
  linkNotes: vi.fn(),
}))

let semantic: typeof import('../src/main/semantic.js')
let memory: typeof import('../src/main/memory-plan.js')
const note = (id: string) => ({ front: { id, status: 'current', type: 'hub', derived_from: [] }, body: id })
const context = { paths: {}, store: { getAll: () => fake.notes } } as unknown as VaultContext
beforeEach(async () => {
  vi.resetModules()
  vi.useFakeTimers()
  fake.free = 2.2e9; fake.footprint = 0.4e9; fake.loads = 0; fake.closes = 0; fake.notes = [note('one')]
  fake.embed.mockReset().mockImplementation(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])))
  memory = await import('../src/main/memory-plan.js')
  semantic = await import('../src/main/semantic.js')
})
afterEach(() => { semantic.stopSemantic(); vi.clearAllTimers(); vi.useRealTimers() })

it('loads once at 2.2GB, then indexes and queries at 1.8GB without cycling the model', async () => {
  semantic.startSemantic(context)
  await vi.advanceTimersByTimeAsync(200)
  expect(fake.loads).toBe(1)
  expect(fake.free).toBe(1.8e9)
  expect(await semantic.semanticQuery('query', 2)).toEqual([{ id: 'one', score: 1 }])
  expect(await semantic.semanticQueryIfLive('web query', 2)).toEqual([{ id: 'one', score: 1 }])
  fake.notes.push(note('two'))
  semantic.semanticNotesChanged()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(fake.embed).toHaveBeenCalledWith(['two'])
  expect(fake.loads).toBe(1)
  expect(fake.closes).toBe(0)
})

it('honors other reservations at cold admission and while using a loaded model', async () => {
  const release = memory.reserveRoom(0.3e9)
  semantic.startSemantic(context)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(fake.loads).toBe(0)
  release()
  await vi.advanceTimersByTimeAsync(60_200)
  expect(fake.loads).toBe(1)
  const busy = memory.reserveRoom(0.9e9)
  const calls = fake.embed.mock.calls.length
  expect(await semantic.semanticQueryIfLive('wait', 2)).toEqual([])
  expect(fake.embed).toHaveBeenCalledTimes(calls)
  busy()
  expect(await semantic.semanticQueryIfLive('resume', 2)).toHaveLength(1)
})

it('unloads below 1GB, stays unloaded below 2GB, and resumes after recovery', async () => {
  semantic.startSemantic(context)
  await vi.advanceTimersByTimeAsync(200)
  fake.free = 0.9e9
  expect(await semantic.semanticQueryIfLive('wait', 2)).toEqual([])
  await vi.advanceTimersByTimeAsync(15_000)
  expect(fake.closes).toBe(1)
  expect(fake.free).toBe(1.3e9)
  expect(await semantic.semanticQuery('wait', 2)).toEqual([])
  fake.notes.push(note('two'))
  semantic.semanticNotesChanged()
  await vi.advanceTimersByTimeAsync(150_000)
  expect(fake.loads).toBe(1)
  fake.free = 2.2e9
  await vi.advanceTimersByTimeAsync(60_200)
  expect(fake.loads).toBe(2)
  expect(fake.embed).toHaveBeenCalledWith(['two'])
  expect(await semantic.semanticQueryIfLive('recovered', 2)).toHaveLength(2)
})

it('leaves the use floor available after its full 1GB load reservation', async () => {
  fake.free = memory.ROOM_FOR_EMBEDDER
  fake.footprint = memory.EMBEDDER_FOOTPRINT
  semantic.startSemantic(context)
  await vi.advanceTimersByTimeAsync(15_200)
  expect(fake.free).toBe(memory.EMBEDDER_MIN_FREE)
  expect(fake.loads).toBe(1)
  expect(fake.closes).toBe(0)
  expect(await semantic.semanticQueryIfLive('boundary', 2)).toHaveLength(1)
})
