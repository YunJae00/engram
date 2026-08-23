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
import { app, ipcMain, net, powerMonitor } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SemanticStatusDto } from '../shared/types.js'
import { broadcast, isLibrarianBusy } from './ipc.js'
import { fabricAfterIndex } from './memory-fabric.js'
import { loadSettings } from './settings.js'
import type { VaultContext } from './vault.js'

const DEFAULT_MODEL = 'Xenova/bge-m3'
const EMBED_BATCH = 8
const SAVE_EVERY = 512
const REINDEX_DEBOUNCE_MS = 30_000

type Extractor = (texts: string[], opts: { pooling: 'cls'; normalize: boolean }) => Promise<{
  dims: number[]
  data: Float32Array | number[]
}>

interface SemanticState {
  status: SemanticStatusDto['status']
  detail: string
  model: string
  extractor: Extractor | null
  // The underlying pipeline handle, kept so idle unload can dispose the
  // native ONNX session (the ~800MB of the whole feature).
  pipe: { dispose?: () => Promise<void> } | null
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
  pipe: null,
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

let fetchPatched = false
function installProxyAwareFetch(): void {
  if (fetchPatched) return
  fetchPatched = true
  const original = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (/^https?:/i.test(url)) return net.fetch(url, init)
    } catch {
      /* malformed input — let the original handle (and reject) it */
    }
    return original(input, init)
  }) as typeof fetch
}

function bundledModelPath(model: string): string | null {
  const candidates = [
    join(process.resourcesPath ?? '', 'bin', 'model'),
    join(app.getAppPath(), 'bundle', 'model'),
    join(dirname(process.argv[1] ?? ''), '..', '..', 'bundle', 'model'),
  ]
  for (const dir of candidates) {
    if (existsSync(join(dir, ...model.split('/'), 'config.json'))) return dir
  }
  return null
}

async function loadExtractor(model: string): Promise<void> {
  installProxyAwareFetch()
  const tf = await import('@huggingface/transformers')
  tf.env.cacheDir = join(app.getPath('userData'), 'models')
  const bundled = bundledModelPath(model)
  if (bundled) {
    tf.env.localModelPath = bundled
    tf.env.allowLocalModels = true
  }
  let lastPct = -1
  const pipe = await tf.pipeline('feature-extraction', model, {
    dtype: 'q8',
    session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    progress_callback: (p: { status?: string; progress?: number }) => {
      if (p.status === 'progress' && typeof p.progress === 'number') {
        const pct = Math.floor(p.progress)
        if (pct !== lastPct) {
          lastPct = pct
          state.detail = `downloading model ${pct}%`
        }
      }
    },
  })
  state.pipe = pipe as unknown as SemanticState['pipe']
  state.extractor = ((texts, opts) => (pipe as unknown as Extractor)(texts, opts)) as Extractor
}

// Model available on demand: loads it if missing, joins an in-flight load.
async function ensureExtractor(): Promise<void> {
  if (state.extractor) return
  if (!state.loading) {
    state.loading = loadExtractor(state.model).finally(() => {
      state.loading = null
    })
  }
  await state.loading
}

function unloadModel(): void {
  const pipe = state.pipe
  state.extractor = null
  state.pipe = null
  if (pipe?.dispose) void pipe.dispose().catch(() => {})
  if (state.status === 'ready') state.detail = `${state.index?.ids.length ?? 0} memories embedded (model resting)`
}

function liveNotes(ctx: VaultContext): Note[] {
  return ctx.store.getAll().filter((n) => n.front.status === 'current' || n.front.status === 'disputed')
}

async function embedBatch(texts: string[]): Promise<Float32Array[]> {
  state.lastUsed = Date.now()
  const out = await state.extractor!(texts, { pooling: 'cls', normalize: true })
  const dim = out.dims[out.dims.length - 1]!
  const data = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data)
  return texts.map((_, i) => data.subarray(i * dim, (i + 1) * dim))
}

// Incremental (re)index: embed only notes whose content digest changed.
// Serialized by `busy`; a change arriving mid-run just re-schedules.
async function reindex(): Promise<void> {
  const ctx = state.ctx
  if (!ctx || state.busy) return
  state.busy = true
  try {
    await ensureExtractor() // idle unload may have put the model to rest
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
    const wasError = state.status === 'error'
    state.status = 'error'
    state.detail = String((err as Error).message ?? err).slice(0, 160)
    if (!wasError) broadcast({ type: 'semantic:error', detail: state.detail })
  } finally {
    state.busy = false
  }
}

// The reflexive association: for each just-embedded note that has no links
// yet, take its single nearest neighbour above a strict floor and record the
// link with an honest reason. Strict on purpose — a wrong reflex-link teaches
// the user to distrust every link, so below the floor we simply do nothing
// and leave the judgment to the librarian.
const ASSOCIATE_FLOOR = 0.66

async function autoAssociate(ctx: VaultContext, index: VectorIndex, freshIds: string[]): Promise<void> {
  const byId = new Map(ctx.store.getAll().map((n) => [n.front.id, n]))
  for (const id of freshIds.slice(0, 200)) {
    try {
      const note = byId.get(id)
      if (!note || note.front.derived_from.length > 0) continue
      if (note.front.type === 'hub') continue
      const row = index.ids.indexOf(id)
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

// Idle watchdog: with no embed work for IDLE_UNLOAD_MS the model rests.
let watchdogArmed = false
function armIdleWatchdog(): void {
  if (watchdogArmed) return
  watchdogArmed = true
  setInterval(() => {
    if (state.extractor && !state.busy && Date.now() - state.lastUsed > IDLE_UNLOAD_MS) unloadModel()
  }, 60_000)
}

async function bringUp(): Promise<void> {
  try {
    await ensureExtractor()
    if (state.ctx) await reindex()
    else if (state.status === 'loading') state.detail = 'model ready'
  } catch (err) {
    const wasError = state.status === 'error'
    state.status = 'error'
    state.detail = String((err as Error).message ?? err).slice(0, 160)
    // Search degrading to lexical-only must not be fully silent — one toast
    // per transition (not per retry), the details stay in Settings.
    if (!wasError) broadcast({ type: 'semantic:error', detail: state.detail })
    // Boot raced a flaky network (laptop waking, VPN connecting) — the
    // layer quietly tries again instead of staying dead until restart.
    setTimeout(() => {
      if (state.status === 'error') {
        state.status = 'loading'
        void bringUp()
      }
    }, 10 * 60_000)
  }
}

function configure(): boolean {
  const settings = loadSettings()
  state.model = (settings as { semanticModel?: string }).semanticModel || DEFAULT_MODEL
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
  // A probe runs against a vault that was made a second ago and has to search
  // it by meaning the way a lived-in vault is searched. Waiting out the quiet
  // moment would only be waiting.
  if (process.env['ENGRAM_INDEX_NOW'] === '1') {
    void bringUp()
    return
  }
  const bootAt = Date.now()
  state.detail = 'waiting for a quiet moment to index'
  const tick = (): void => {
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

// Vault boot: attach the vault and index it (joins the warm-up's in-flight
// model load instead of starting a second one). With the model already on
// disk the heavy part defers to idle; a missing model still downloads
// immediately (that IS the onboarding UX).
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

// The notes watcher calls this on every disk delta; the actual work is
// debounced well past the librarian's own write bursts. reindex reloads a
// resting model itself, so this stays armed while the model is unloaded.
export function semanticNotesChanged(): void {
  if (state.status === 'off' || state.status === 'error') return
  if (state.timer) clearTimeout(state.timer)
  state.timer = setTimeout(function fire() {
    // Mid-sweep the librarian is still writing the very notes we would
    // embed — wait it out and try again, instead of racing it for cores.
    if (isLibrarianBusy()) {
      state.timer = setTimeout(fire, 60_000)
      return
    }
    void reindex()
  }, REINDEX_DEBOUNCE_MS)
}

// Meaning-level hits for a query — [] whenever the layer is not ready, so
// callers can always merge the result without caring about status. A resting
// (idle-unloaded) model gets a bounded wait, not a skip: the first question
// after a break is the most common question, and a warm-from-disk load is a
// few seconds against an engine call that takes tens. Past the budget this
// question falls back to lexical+association and the load keeps going.
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

// The errand lane: meaning-level hits only when the embedder is ALREADY
// resident. A web errand shares 8GB with the language model and a Chrome —
// waking the ~800MB embedder for it is how machines start paging, so this
// never loads or waits, unlike semanticQuery above.
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
