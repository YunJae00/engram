import {
  applyEmbeddings,
  cosineTopK,
  embedDigestOf,
  embedTextOf,
  emptyVectorIndex,
  linkNotes,
  loadVectorIndex,
  saveVectorIndex,
  staleForEmbedding,
  type Note,
  type SemanticHit,
  type VectorIndex,
} from 'core'
import { app, ipcMain, powerMonitor } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SemanticStatusDto } from '../shared/types.js'
import { broadcast, isLibrarianBusy } from './ipc.js'
import { fabricAfterIndex } from './memory-fabric.js'
import { EmbeddingClient } from './embedding-client.js'
import { embeddingAssets } from './embedding-assets.js'
import { reserveRoom, ROOM_FOR_EMBEDDER, roomNow } from './memory-plan.js'
import { serialWork } from './serial-work.js'
import type { VaultContext } from './vault.js'

const DEFAULT_MODEL = 'Xenova/bge-m3'
const EMBED_BATCH = 4
const SAVE_EVERY = 512
const REINDEX_DEBOUNCE_MS = 30_000

interface SemanticState {
  status: SemanticStatusDto['status']
  detail: string
  model: string
  extractor: EmbeddingClient | null
  loading: Promise<void> | null
  lastUsed: number
  index: VectorIndex | null
  ctx: VaultContext | null
  busy: boolean
  timer: NodeJS.Timeout | null
}

const state: SemanticState = {
  status: 'off',
  detail: '',
  model: DEFAULT_MODEL,
  extractor: null,
  loading: null,
  lastUsed: 0,
  index: null,
  ctx: null,
  busy: false,
  timer: null,
}

const IDLE_UNLOAD_MS = 10 * 60_000

function semanticEnabled(): boolean {
  return app.isPackaged || process.env['ENGRAM_SEMANTIC'] === '1'
}

function modelRoots(): string[] {
  return [
    join(process.resourcesPath ?? '', 'bin', 'model'),
    join(app.getAppPath(), 'bundle', 'model'),
    join(dirname(process.argv[1] ?? ''), '..', '..', 'bundle', 'model'),
  ]
}

function bundledModelPath(model: string): string | null {
  for (const dir of modelRoots()) {
    if (existsSync(join(dir, ...model.split('/'), 'config.json'))) return dir
  }
  return null
}

let stopping: Promise<void> = Promise.resolve()
let loadAbort: AbortController | null = null
let closed = false

async function loadExtractor(model: string): Promise<void> {
  await stopping
  if (closed) throw new Error('Semantic search is stopping')
  const abort = new AbortController()
  loadAbort = abort
  const timer = setTimeout(() => abort.abort(), 10 * 60_000)
  let client: EmbeddingClient | undefined
  const cancel = () => { if (client) stopping = client.close() }
  abort.signal.addEventListener('abort', cancel, { once: true })
  try {
    const root = await embeddingAssets(model, modelRoots(), join(app.getPath('userData'), 'models'), abort.signal, detail => { state.detail = detail })
    abort.signal.throwIfAborted()
    state.detail = 'loading model'
    client = new EmbeddingClient(root, model)
    await client.ready
    abort.signal.throwIfAborted()
    state.extractor = client
    state.lastUsed = Date.now()
  } catch (error) {
    if (client) { stopping = client.close(); await stopping }
    throw error
  } finally {
    clearTimeout(timer)
    abort.signal.removeEventListener('abort', cancel)
    if (loadAbort === abort) loadAbort = null
  }
}

async function ensureExtractor(): Promise<boolean> {
  if (closed) return false
  if (state.extractor) return true
  if (!state.loading) {
    if (roomNow() < ROOM_FOR_EMBEDDER) return false
    const release = reserveRoom(1e9)
    state.loading = loadExtractor(state.model).finally(() => {
      release()
      state.loading = null
    })
  }
  await state.loading
  return Boolean(state.extractor)
}

function unloadModel(): void {
  const client = state.extractor
  state.extractor = null
  if (client) stopping = client.close()
  if (state.status === 'ready') state.detail = `${state.index?.ids.length ?? 0} memories embedded (model resting)`
}

export function stopSemantic(): void {
  closed = true
  if (state.timer) clearTimeout(state.timer)
  loadAbort?.abort()
  unloadModel()
}

function liveNotes(ctx: VaultContext): Note[] {
  return ctx.store.getAll().filter((n) => n.front.status === 'current' || n.front.status === 'disputed')
}

const embeddings = serialWork()
function embedBatch(texts: string[]): Promise<Float32Array[]> {
  if (embeddings.pending >= 8) return Promise.reject(new Error('Embedding queue is full'))
  return embeddings.run(async () => {
    if (!state.extractor || roomNow() < 2.5e9) throw new Error('Embedding paused to preserve memory for active work')
    state.lastUsed = Date.now()
    const client = state.extractor
    try { return await client.embed(texts) }
    catch (error) { if (client.closed && state.extractor === client) unloadModel(); throw error }
  })
}

function deferForMemory(): void {
  if (closed) return
  state.detail = 'Indexing paused until more memory is available'
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(() => void bringUp(), 60_000).unref()
}

// Incrementally embed changed notes; `busy` serializes index passes.
async function reindex(): Promise<void> {
  const ctx = state.ctx
  if (closed || !ctx || state.busy) return
  if (roomNow() < ROOM_FOR_EMBEDDER) { deferForMemory(); return }
  state.busy = true
  try {
    if (!await ensureExtractor()) { deferForMemory(); return }
    const live = liveNotes(ctx)
    const liveIds = new Set(live.map((n) => n.front.id))
    let index = state.index ?? (await loadVectorIndex(ctx.paths, state.model))
    if (!index) {
      const probe = await embedBatch(['probe'])
      index = emptyVectorIndex(state.model, probe[0]!.length)
    }
    const stale = staleForEmbedding(live, index)
    if (stale.length > 0) {
      state.status = 'indexing'
      let done = 0
      for (let i = 0; i < stale.length; i += EMBED_BATCH) {
        if (roomNow() < 3e9) {
          await saveVectorIndex(ctx.paths, index)
          state.index = index
          state.status = 'ready'
          deferForMemory()
          return
        }
        const batch = stale.slice(i, i + EMBED_BATCH)
        const vectors = await embedBatch(batch.map(embedTextOf))
        index = applyEmbeddings(
          index,
          batch.map((n, j) => ({ id: n.front.id, digest: embedDigestOf(n), vector: vectors[j]! })),
          liveIds,
        )
        done += batch.length
        state.detail = `indexing ${done}/${stale.length}`
        if (done % SAVE_EVERY < EMBED_BATCH) await saveVectorIndex(ctx.paths, index)
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    } else if (index.ids.some((id) => !liveIds.has(id))) {
      index = applyEmbeddings(index, [], liveIds) // drop dead rows
    }
    await saveVectorIndex(ctx.paths, index)
    state.index = index
    state.status = 'ready'
    state.detail = `${index.ids.length} memories embedded`
    if (stale.length > 0) await autoAssociate(ctx, index, stale.map((n) => n.front.id))
    await fabricAfterIndex(index, stale.map((n) => n.front.id), liveIds)
  } catch (err) {
    if (closed) return
    if (roomNow() < 3e9) {
      state.status = state.index ? 'ready' : 'loading'
      deferForMemory()
      return
    }
    const wasError = state.status === 'error'
    state.status = 'error'
    state.detail = String((err as Error).message ?? err).slice(0, 160)
    if (!wasError) broadcast({ type: 'semantic:error', detail: state.detail })
  } finally {
    state.busy = false
  }
}

// Only associate a fresh note with its closest sufficiently similar neighbour.
const ASSOCIATE_FLOOR = 0.66

async function autoAssociate(ctx: VaultContext, index: VectorIndex, freshIds: string[]): Promise<void> {
  const byId = new Map(ctx.store.getAll().map((n) => [n.front.id, n]))
  const rowOf = new Map(index.ids.map((one, row) => [one, row]))
  for (const id of freshIds.slice(0, 200)) {
    try {
      const note = byId.get(id)
      if (!note || note.front.derived_from.length > 0) continue
      if (note.front.type === 'hub') continue
      const row = rowOf.get(id) ?? -1
      if (row < 0) continue
      const vec = index.vectors.subarray(row * index.dim, (row + 1) * index.dim)
      const hits = cosineTopK(index, vec, 3).filter((h) => h.id !== id && (h.score ?? 0) >= ASSOCIATE_FLOOR)
      const best = hits[0]
      if (!best) continue
      const neighbour = byId.get(best.id)
      if (!neighbour || neighbour.front.type === 'hub') continue
      await linkNotes(ctx.paths, id, best.id, 'felt similar (semantic association)')
    } catch {
      /* one bad note must not stop the pass */
    }
  }
}

let watchdogArmed = false
function armIdleWatchdog(): void {
  if (watchdogArmed) return
  watchdogArmed = true
  setInterval(() => {
    if (state.extractor && !state.busy && !state.loading && embeddings.pending === 0
      && (roomNow() < 3.5e9 || Date.now() - state.lastUsed > IDLE_UNLOAD_MS)) unloadModel()
  }, 15_000).unref()
}

async function bringUp(): Promise<void> {
  if (closed) return
  try {
    if (!await ensureExtractor()) { deferForMemory(); return }
    if (state.ctx) await reindex()
    else if (state.status === 'loading') state.detail = 'model ready'
  } catch (err) {
    if (closed) return
    const wasError = state.status === 'error'
    state.status = 'error'
    state.detail = String((err as Error).message ?? err).slice(0, 160)
    // Notify once per transition; retain details in Settings.
    if (!wasError) broadcast({ type: 'semantic:error', detail: state.detail })
    // Retry a transient startup failure without requiring an app restart.
    setTimeout(() => {
      if (state.status === 'error') {
        state.status = 'loading'
        void bringUp()
      }
    }, 10 * 60_000)
  }
}

function configure(): boolean {
  if (!semanticEnabled()) {
    state.status = 'off'
    return false
  }
  return true
}

export function warmSemantic(): void {
  if (!configure()) return
  if (state.extractor || state.loading) return
  if (bundledModelPath(state.model)) return
  state.status = 'loading'
  state.detail = 'preparing model'
  armIdleWatchdog()
  void bringUp()
}

const BOOT_DEFER_FIRST_MS = 2 * 60_000
const BOOT_IDLE_SECONDS = 60
const BOOT_CEILING_MS = 30 * 60_000

function scheduleBootIndex(): void {
  // Isolated smoke tests explicitly bypass the idle delay.
  if (process.env['ENGRAM_INDEX_NOW'] === '1') {
    void bringUp()
    return
  }
  const bootAt = Date.now()
  state.detail = 'waiting for a quiet moment to index'
  const tick = (): void => {
    if (closed) return
    if (state.extractor || state.busy) return // something else already brought it up
    const ceiling = (powerMonitor.isOnBatteryPower?.() ? 2 : 1) * BOOT_CEILING_MS
    let idleSeconds = Number.POSITIVE_INFINITY
    try {
      idleSeconds = powerMonitor.getSystemIdleTime()
    } catch {
      /* API unavailable → treat as idle and just run */
    }
    if (idleSeconds >= BOOT_IDLE_SECONDS || Date.now() - bootAt >= ceiling) {
      void bringUp()
      return
    }
    setTimeout(tick, 60_000)
  }
  setTimeout(tick, BOOT_DEFER_FIRST_MS)
}

// Join any warm-up; defer bundled models to idle, download missing ones now.
export function startSemantic(ctx: VaultContext): void {
  state.ctx = ctx
  if (!configure()) return
  if (state.status === 'off' || state.status === 'error') {
    state.status = 'loading'
    state.detail = 'preparing model'
  }
  armIdleWatchdog()
  if (bundledModelPath(state.model)) scheduleBootIndex()
  else void bringUp()
}

// Debounce disk changes past librarian write bursts, even with the model unloaded.
export function semanticNotesChanged(): void {
  if (closed || state.status === 'off' || state.status === 'error') return
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(function fire() {
    if (closed) return
    // Wait for librarian write bursts to finish.
    if (isLibrarianBusy() || roomNow() < ROOM_FOR_EMBEDDER) {
      state.timer = setTimeout(fire, 60_000)
      return
    }
    void reindex()
  }, REINDEX_DEBOUNCE_MS)
}

// Bound the wait for a resting model; lexical search remains the fallback.
const RESTING_MODEL_WAIT_MS = 6_000

export async function semanticQuery(query: string, k: number): Promise<SemanticHit[]> {
  if (state.status !== 'ready' || !state.index) return []
  if (!state.extractor) {
    await Promise.race([
      ensureExtractor().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, RESTING_MODEL_WAIT_MS)),
    ])
    if (!state.extractor) return []
  }
  try {
    const [vec] = await embedBatch([query])
    return cosineTopK(state.index, vec!, k)
  } catch {
    return []
  }
}

// Web errands never load the model: preserve memory for active browser work.
export async function semanticQueryIfLive(query: string, k: number): Promise<SemanticHit[]> {
  if (state.status !== 'ready' || !state.index || !state.extractor) return []
  try {
    const [vec] = await embedBatch([query])
    return cosineTopK(state.index, vec!, k)
  } catch {
    return []
  }
}

export function registerSemanticIpc(): void {
  ipcMain.handle(
    'semantic:status',
    (): SemanticStatusDto => ({ status: state.status, detail: state.detail, model: state.model }),
  )
}
