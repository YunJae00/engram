import { app, ipcMain, net } from 'electron'
import { fork, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { once } from 'node:events'
import { mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalModelDto, LocalModelsStateDto } from '../shared/types.js'
import { broadcast } from './ipc.js'
import { planModelLoad, PRESSURE_FLOOR } from './memory-plan.js'
import { markEngineOk, markEngineUnhealthy } from './engine-health.js'
import { flog } from './flog.js'

interface ModelSpec {
  id: string
  label: string
  file: string
  url: string
  approxGB: number
  // Minimum comfortable TOTAL system RAM in GB (q4, ctx 4-8k).
  ramGB: number
  tag: 'korean' | 'balanced' | 'light' | 'power'
  desc: string
}

// One brain only: on shared-iGPU machines every offloaded layer is pinned
// system RAM, and the larger variants pinned more than a working day could
// spare — measured as hard freezes, not slowdowns. A spec stays on this list
// only if it loads safely beside the user's normal workload, and today that
// is the smallest one.
const MODELS: ModelSpec[] = [
  {
    id: 'gemma4-e2b',
    label: 'Gemma 4 E2B',
    file: 'gemma-4-E2B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf',
    approxGB: 3.1,
    ramGB: 8,
    tag: 'light',
    desc: 'Small and quick — runs comfortably beside your other work.',
  },
]

// Short on purpose: an idle model is pinned memory the user's next task
// will need, and the reload it saves is cheaper than a frozen machine
// (three hard freezes in one day traced to exactly this residency).
const IDLE_UNLOAD_MS = 5 * 60_000
const CTX_TOKENS = 4_096
// Generous: a cold context on a big model is slow, but silence forever is worse.
const INFERENCE_TIMEOUT_MS = 4 * 60_000

function modelsDir(): string {
  return join(app.getPath('userData'), 'models', 'gguf')
}
function stateFile(): string {
  return join(app.getPath('userData'), 'local-llm.json')
}

interface LocalState {
  activeModelId?: string
}

async function readState(): Promise<LocalState> {
  try {
    return JSON.parse(await readFile(stateFile(), 'utf8')) as LocalState
  } catch {
    return {}
  }
}

async function modelPresent(spec: ModelSpec): Promise<boolean> {
  try {
    const s = await stat(join(modelsDir(), spec.file))
    // A stub or truncated file must not count — a model is gigabytes.
    return s.size > 1_000_000_000 * (spec.approxGB * 0.5)
  } catch {
    return false
  }
}

// ── Download manager ────────────────────────────────────────────────────
const downloads = new Map<string, { controller: AbortController }>()

async function chromiumStream(
  url: string,
  from: number,
  onPart: (chunk: Uint8Array) => Promise<void>,
  signal: AbortSignal,
  onStart: (resumed: boolean, total: number) => void,
): Promise<void> {
  // Chromium's fetch, not Node's: corporate TLS-inspecting proxies break
  // Node's fetch while the browser stack negotiates fine.
  const res = await net.fetch(url, {
    signal,
    ...(from > 0 ? { headers: { Range: `bytes=${from}-` } } : {}),
  })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  // 206 means the server honoured the Range and the body continues where the
  // partial file stopped; a 200 answer restarts from byte zero whatever we asked.
  const resumed = from > 0 && res.status === 206
  const length = Number(res.headers.get('content-length') ?? 0)
  onStart(resumed, resumed ? from + length : length)
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) await onPart(value)
  }
}

async function freeSpaceOk(need: number): Promise<boolean> {
  try {
    const { bsize, bavail } = await statfs(modelsDir())
    return bsize * bavail > need
  } catch {
    // Unknown is not a reason to refuse — the write error path catches it.
    return true
  }
}

async function downloadModel(id: string): Promise<{ ok: boolean; log?: string }> {
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) return { ok: false, log: 'unknown model' }
  if (downloads.has(id)) return { ok: true }
  await mkdir(modelsDir(), { recursive: true })
  const finalPath = join(modelsDir(), spec.file)
  const partPath = `${finalPath}.part`
  // Multi-gigabyte writes onto a nearly full disk fail late and confusingly.
  const prior = await stat(partPath).catch(() => null)
  if (!(await freeSpaceOk(spec.approxGB * 1e9 - (prior?.size ?? 0))))
    return { ok: false, log: `not enough free disk space — ${spec.approxGB}GB needed` }
  const controller = new AbortController()
  downloads.set(id, { controller })
  announce()
  let received = prior?.size ?? 0
  let total = spec.approxGB * 1e9
  let lastTick = 0
  const sink: { out: WriteStream | null } = { out: null }
  let writeFailure: Error | null = null
  try {
    await chromiumStream(
      spec.url,
      prior?.size ?? 0,
      async (chunk) => {
        if (writeFailure) throw writeFailure
        // Backpressure: a disk slower than the network used to buffer the
        // whole difference in memory.
        if (!sink.out!.write(chunk)) await once(sink.out!, 'drain')
        received += chunk.length
        const now = Date.now()
        if (now - lastTick > 500) {
          lastTick = now
          broadcast({ type: 'localmodel:progress', id, received, total })
        }
      },
      controller.signal,
      (resumed, size) => {
        if (size > 0) total = size
        if (!resumed) received = 0
        sink.out = createWriteStream(partPath, { flags: resumed ? 'a' : 'w' })
        // Without this the first failed write (a full disk) is an unhandled
        // error per chunk, each one a synchronous log write on the main thread.
        sink.out.on('error', (err: Error) => {
          writeFailure = err
          controller.abort()
        })
      },
    )
    if (writeFailure) throw writeFailure
    await new Promise<void>((resolve, reject) => sink.out?.end((err: unknown) => (err ? reject(err) : resolve())))
    await rename(partPath, finalPath)
    broadcast({ type: 'localmodel:progress', id, received: total, total })
    return { ok: true }
  } catch (err) {
    sink.out?.destroy()
    // Only a real cancel throws the partial away. A network drop keeps it, so
    // pressing Download again resumes instead of restarting from zero.
    if (controller.signal.aborted && !writeFailure) {
      await rm(partPath, { force: true }).catch(() => undefined)
      return { ok: false, log: 'canceled' }
    }
    flog('localmodel-download-failed', writeFailure ?? err)
    return { ok: false, log: String(writeFailure ?? err).slice(0, 200) }
  } finally {
    downloads.delete(id)
    announce()
  }
}

// Reclaiming the disk: these files are gigabytes, so a machine that switched
// models has no other way to get the space back.
async function deleteModel(id: string): Promise<{ ok: boolean; reason?: string }> {
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) return { ok: false, reason: 'unknown model' }
  // A running download owns both the .part file and the write stream. Cancel is
  // the action for that state; deleting underneath it would race the writer.
  if (downloads.has(id)) return { ok: false, reason: 'downloading' }
  const state = await readState()
  const active = state.activeModelId === id
  if (active || loadedModelId === id) {
    // The worker has the file mmap'd. Unlinking it there leaves the space
    // claimed until the process dies (and on Windows fails outright), so the
    // worker goes first and the next question reloads whatever is left.
    stopLocalServer()
  }
  if (active) {
    state.activeModelId = undefined
    await writeFile(stateFile(), JSON.stringify(state)).catch(() => undefined)
  }
  const finalPath = join(modelsDir(), spec.file)
  try {
    // The .part sibling is an aborted download's leftover — invisible in the
    // list and just as large, so it goes with the model it belongs to.
    await rm(finalPath, { force: true })
    await rm(`${finalPath}.part`, { force: true })
  } catch (err) {
    flog('localmodel-delete-failed', err)
    return { ok: false, reason: String(err).slice(0, 200) }
  }
  flog('local-llm', `deleted model ${id}`)
  return { ok: true }
}

// A model dropped from the list has no card, so no delete button — without
// this sweep its gigabytes would sit on disk invisibly forever. Runs before
// any worker exists, so nothing holds the files open.
async function sweepRetiredModels(): Promise<void> {
  const keep = new Set(MODELS.flatMap((m) => [m.file, `${m.file}.part`]))
  const entries = await readdir(modelsDir()).catch(() => [] as string[])
  for (const name of entries) {
    if (keep.has(name)) continue
    if (!name.endsWith('.gguf') && !name.endsWith('.gguf.part')) continue
    await rm(join(modelsDir(), name), { force: true }).catch(() => undefined)
    flog('local-llm', `swept retired model file ${name}`)
  }
}

// ── Inference host ──────────────────────────────────────────────────────
// Inference runs in a child process: loading a multi-GB model takes 20-40s of
// mmap and GPU init, and doing that in the main process froze every window.
// The child is this same signed binary run as plain Node — endpoint protection
// that blocks unsigned executables leaves it alone, and unlike a sandboxed
// utility process it keeps the GPU access the model needs (a sandboxed one
// loaded the model and then sat at 0% CPU forever).
let child: ChildProcess | null = null
let childReady: Promise<ChildProcess | null> | null = null
// Which model the worker was last told to load. Deleting a file the worker
// still holds open leaves a phantom on Windows and a live mmap elsewhere, and
// the active id alone does not answer it — an adopted model loads with no id
// ever written to the state file.
let loadedModelId: string | null = null
let lastUsed = 0
let nextCallId = 1
const pending = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void; onToken?: (text: string) => void }>()

function workerPath(): string {
  // The main bundle is ESM — resolve the sibling entry from this module's own
  // URL rather than __dirname, which does not exist here.
  return fileURLToPath(new URL('llm-worker.js', import.meta.url))
}

function failAllPending(reason: string): void {
  for (const [, waiter] of pending) waiter.reject(new Error(reason))
  pending.clear()
}

// Warm state, tracked here because the worker only announces 'loaded' once
// per load — a chat panel opening against an already-warm model must read
// 'ready' without another round trip. 'cold' means the next question pays
// the multi-second model load.
export type LlmWarmState = 'cold' | 'loading' | 'ready'
let warmState: LlmWarmState = 'cold'
function setWarmState(next: LlmWarmState): void {
  if (warmState === next) return
  warmState = next
  broadcast({ type: 'localllm:warm', state: next })
}

function spawnChild(): Promise<ChildProcess | null> {
  if (childReady) return childReady
  childReady = new Promise<ChildProcess | null>((resolve) => {
    let settled = false
    let abandoned = false
    // Every exit from this function used to be silent, so a worker that never
    // started looked exactly like a model that was simply slow.
    flog('local-llm', `starting the inference worker (${workerPath()})`)
    const proc = fork(workerPath(), [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    // Below-normal priority: a generation burst saturates every performance
    // core, and the user's foreground work — not the background brain — should
    // win those cycles. Answers arrive a beat later; typing never stutters.
    try {
      if (proc.pid) os.setPriority(proc.pid, 10)
    } catch {
      /* not permitted on some platforms — the worker just runs at normal */
    }
    proc.on('message', (message: { type: string; id?: number; text?: string; ms?: number; gpu?: string; mode?: string; layers?: number; message?: string }) => {
      if (message.type === 'ready') {
        if (!settled) {
          settled = true
          child = proc
          resolve(proc)
        }
        return
      }
      if (message.type === 'loaded') {
        flog(
          'local-llm',
          `model loaded in ${message.ms}ms (worker, gpu: ${message.gpu ?? '?'}, mode: ${message.mode ?? '?'}, layers: ${message.layers ?? '?'})`,
        )
        markEngineOk('local') // clears a red dot from an earlier failed load
        setWarmState('ready')
        return
      }
      if (message.type === 'load-failed') {
        flog('local-llm-load-failed', message.message)
        // The model file's presence passes detection and pings exempt
        // 'local' — this message is the only evidence the brain is broken.
        markEngineUnhealthy('local', 'crash')
        setWarmState('cold')
        return
      }
      const waiter = message.id === undefined ? undefined : pending.get(message.id)
      if (!waiter || message.id === undefined) return
      if (message.type === 'chunk') {
        waiter.onToken?.(message.text ?? '')
        return
      }
      pending.delete(message.id)
      if (message.type === 'done') waiter.resolve(message.text ?? '')
      else waiter.reject(new Error(message.message ?? 'inference failed'))
    })
    proc.on('exit', (code, signal) => {
      flog('local-llm', `inference worker exited (code ${code ?? '-'}, signal ${signal ?? '-'})`)
      // The ready timeout already cleared the slot for a retry; a late exit from
      // the fork it abandoned must not null out the worker that replaced it.
      if (abandoned) return
      child = null
      childReady = null
      loadedModelId = null
      setWarmState('cold')
      failAllPending('the inference process exited')
      if (!settled) {
        settled = true
        resolve(null)
      }
    })
    proc.on('error', (err) => {
      flog('local-llm-worker-error', err)
      child = null
      childReady = null
      failAllPending('the inference process could not start')
      if (!settled) {
        settled = true
        resolve(null)
      }
    })
    // A worker that never says hello is a broken install — or a cold start slow
    // enough (first launch after an update, an antivirus sweep, a machine waking
    // from sleep) that it says hello after we stopped listening. Either way the
    // fork is a fork: it is outside core's spawn ledger, so nothing else will
    // ever reap it — kill it here or it lives as long as the app does. Dropping
    // childReady is what makes this recoverable: memoizing the failed promise
    // would leave local inference dead until a restart.
    setTimeout(() => {
      if (settled) return
      settled = true
      flog('local-llm-load-failed', 'the inference worker never reported ready')
      markEngineUnhealthy('local', 'crash')
      abandoned = true
      proc.kill('SIGKILL')
      childReady = null
      resolve(null)
    }, 20_000)
  })
  return childReady
}

// Warm the model without anyone waiting on it — the first question then costs
// nothing, and the load happens where it cannot freeze the UI.
export async function warmLocalModel(): Promise<void> {
  const spec = await adoptDownloadedModel()
  if (!spec) {
    flog('local-llm', 'warm-up skipped — no model is downloaded')
    return
  }
  // Background warm-up is optional by definition — it only happens when the
  // machine will not feel it. A question still loads on demand either way.
  const plan = planModelLoad(spec.approxGB * 1e9)
  if (plan.mode !== 'gpu') {
    flog('local-llm', `warm-up skipped — ${plan.reason}`)
    return
  }
  const proc = await spawnChild()
  if (!proc) {
    flog('local-llm-load-failed', 'warm-up could not start the inference worker')
    return
  }
  if (warmState === 'cold') setWarmState('loading')
  loadedModelId = spec.id
  proc.send({
    type: 'load',
    modelPath: join(modelsDir(), spec.file),
    contextSize: CTX_TOKENS,
    plan: { gpuLayers: plan.gpuLayers, vramPadding: plan.vramPadding, mode: plan.mode },
  })
}

let inFlight: Promise<string> | null = null

// The active model is the QUALITY choice; a 'fast' call (errand slot-filling)
// takes the largest downloaded brain that fits the memory the machine has
// right now — measured here, that is the difference between "refused" and
// "done in a minute".
async function chooseSpec(hint?: 'fast'): Promise<{ spec: ModelSpec; plan: ReturnType<typeof planModelLoad> } | null> {
  const active = await adoptDownloadedModel()
  if (!active) return null
  if (hint !== 'fast') return { spec: active, plan: planModelLoad(active.approxGB * 1e9) }
  const downloaded: ModelSpec[] = []
  for (const spec of MODELS) if (await modelPresent(spec)) downloaded.push(spec)
  const candidates = downloaded.sort((x, y) => y.approxGB - x.approxGB)
  let fallback: { spec: ModelSpec; plan: ReturnType<typeof planModelLoad> } | null = null
  for (const spec of candidates) {
    const plan = planModelLoad(spec.approxGB * 1e9)
    if (plan.mode === 'gpu' || plan.mode === 'lean') return { spec, plan }
    if (plan.mode === 'cpu' && !fallback) fallback = { spec, plan }
  }
  if (fallback) return fallback
  const last = candidates.at(-1)
  return last ? { spec: last, plan: planModelLoad(last.approxGB * 1e9) } : null
}

export async function localComplete(
  prompt: string,
  opts: {
    maxTokens?: number
    signal?: AbortSignal
    onToken?: (text: string) => void
    jsonSchema?: object
    modelHint?: 'fast'
  },
): Promise<string> {
  // Serialize: local inference saturates the machine; overlapping jobs would
  // page-thrash. The librarian is serial anyway (concurrency 1).
  while (inFlight) await inFlight.catch(() => undefined)
  const work = (async () => {
    const chosen = await chooseSpec(opts.modelHint)
    if (!chosen) throw new Error('no local model is active')
    const { spec, plan } = chosen
    // Refusing at the floor is the guard between "slow answer" and "frozen
    // machine" — below it even evictable weights would tip the system over.
    if (plan.mode === 'none')
      throw new Error(`not enough free memory for the local model right now (${plan.reason}) — close something and retry`)
    if (plan.mode !== 'gpu') flog('local-llm', `loading ${plan.mode}: ${plan.reason}`)
    const proc = await spawnChild()
    if (!proc) throw new Error('the inference process could not start')
    if (warmState === 'cold') setWarmState('loading')
    loadedModelId = spec.id
    proc.send({
      type: 'load',
      modelPath: join(modelsDir(), spec.file),
      contextSize: CTX_TOKENS,
      plan: { gpuLayers: plan.gpuLayers, vramPadding: plan.vramPadding, mode: plan.mode },
    })
    lastUsed = Date.now()
    const id = nextCallId++
    const answer = await new Promise<string>((resolve, reject) => {
      // A worker that stops answering must surface as an error rather than a
      // spinner that never ends.
      const timer = setTimeout(() => {
        if (!pending.delete(id)) return
        flog('local-llm', 'inference timed out — restarting the worker')
        stopLocalServer()
        reject(new Error('the local model stopped responding'))
      }, INFERENCE_TIMEOUT_MS)
      const settle = (fn: (value: string) => void) => (value: string) => {
        clearTimeout(timer)
        fn(value)
      }
      const fail = (err: Error) => {
        clearTimeout(timer)
        reject(err)
      }
      pending.set(id, { resolve: settle(resolve), reject: fail, onToken: opts.onToken })
      const onAbort = (): void => {
        pending.delete(id)
        // Stop the generation itself, not just our interest in it.
        proc.send({ type: 'abort', id })
        fail(new Error('canceled'))
      }
      if (opts.signal?.aborted) {
        onAbort()
        return
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      proc.send({ type: 'complete', id, prompt, maxTokens: opts.maxTokens ?? 512, ...(opts.jsonSchema ? { jsonSchema: opts.jsonSchema } : {}) })
    })
    lastUsed = Date.now()
    // Served — and if the room is already gone, leave now instead of squatting
    // for the idle window while the user's own work fights for pages.
    if (os.freemem() < 6e9 && child) {
      flog('local-llm', `answered into a tight machine (${(os.freemem() / 1e9).toFixed(1)}GB free) — unloading`)
      child.send({ type: 'unload' })
      loadedModelId = null
      setWarmState('cold')
      lastUsed = 0
    }
    return answer
  })()
  inFlight = work
  try {
    return await work
  } finally {
    if (inFlight === work) inFlight = null
  }
}

// The model rests after a long quiet spell. Longer than the old ten minutes:
// every unload buys back RAM at the price of the next question paying the
// reload, and the reload is the expensive thing.
function armMemoryWatch(): void {
  setInterval(() => {
    if (!child) return
    const free = os.freemem()
    // Mid-inference the model cannot be unloaded politely, but below the
    // critical floor the machine is minutes from a hard freeze — killing the
    // worker fails one answer and saves the computer.
    if (inFlight && free < 2.5e9) {
      flog('local-llm', `memory critical (${(free / 1e9).toFixed(1)}GB free) — stopping inference to keep the machine alive`)
      stopLocalServer()
      return
    }
    if (inFlight) return
    // The machine's needs keep changing while the model sits idle. When free
    // memory sinks to where the resident model is what would tip the system
    // into thrash, it leaves NOW — the next question pays a reload, which is
    // minutes cheaper than a frozen machine.
    if (free < PRESSURE_FLOOR) {
      flog('local-llm', `memory pressure (${(free / 1e9).toFixed(1)}GB free) — unloading the model`)
      child.send({ type: 'unload' })
      loadedModelId = null
      setWarmState('cold')
      lastUsed = 0
      return
    }
    if (lastUsed === 0 || Date.now() - lastUsed < IDLE_UNLOAD_MS) return
    flog('local-llm', 'idle — unloading the model')
    child.send({ type: 'unload' })
    loadedModelId = null
    setWarmState('cold')
    lastUsed = 0
  }, 8_000)
}
armMemoryWatch()

async function adoptDownloadedModel(): Promise<ModelSpec | null> {
  const state = await readState()
  const chosen = MODELS.find((m) => m.id === state.activeModelId)
  if (chosen && (await modelPresent(chosen))) return chosen
  const downloaded: ModelSpec[] = []
  for (const spec of MODELS) if (await modelPresent(spec)) downloaded.push(spec)
  if (downloaded.length === 0) return null
  const preferred = downloaded.find((m) => m.id === recommendId()) ?? downloaded[downloaded.length - 1]!
  await writeFile(stateFile(), JSON.stringify({ ...state, activeModelId: preferred.id })).catch(() => undefined)
  flog('local-llm', `adopted downloaded model ${preferred.id}`)
  announce()
  return preferred
}

// Detection-grade check: a model is chosen (or adoptable) and really on disk.
// Never loads anything.
export async function localConfigured(): Promise<boolean> {
  return (await adoptDownloadedModel()) !== null
}

// The brain's display name — Diagnostics shows WHICH model is the brain, not
// the engine id ("Gemma 4 E4B", not "local").
export async function activeModelLabel(): Promise<string | null> {
  return (await adoptDownloadedModel())?.label ?? null
}

// What an errand actually needs to start here, sized by the smallest brain a
// 'fast' call can step down to — not by the flagship model nobody would load
// on a tight machine.
export async function errandFloors(): Promise<{ min: number; webMin: number } | null> {
  const downloaded: ModelSpec[] = []
  for (const spec of MODELS) if (await modelPresent(spec)) downloaded.push(spec)
  if (downloaded.length === 0) return null
  const smallest = downloaded.sort((x, y) => x.approxGB - y.approxGB)[0]!
  const base = smallest.approxGB * 1e9
  return { min: base + 2.5e9, webMin: base + 4e9 }
}

// The librarian's own work — sweeps, absorb batches, auto-tidy — must never
// be the reason the machine dies. Background inference runs only when the
// machine can comfortably spare the model AND its own working room; anything
// less defers the tidy, which the absorb queue already survives.
export async function backgroundInferenceOk(): Promise<{ ok: boolean; reason?: string }> {
  const spec = await adoptDownloadedModel()
  if (!spec) return { ok: true }
  const free = os.freemem()
  const need = spec.approxGB * 1e9 + 8e9
  if (free >= need) return { ok: true }
  return {
    ok: false,
    reason: `${(free / 1e9).toFixed(1)}GB free, background tidy wants ~${Math.ceil(need / 1e9)}GB`,
  }
}

// Kept name from the server era — now it stops the inference process.
export function stopLocalServer(): void {
  const proc = child
  child = null
  childReady = null
  loadedModelId = null
  setWarmState('cold')
  failAllPending('shutting down')
  proc?.kill('SIGKILL')
}

// ── Hardware probe for the recommendation badge ─────────────────────────
function recommendId(): string {
  // Total RAM lied on shared-iGPU machines: a 32GB box "qualified" for a 17GB
  // model that could never actually coexist with the user's day. Recommend
  // from what is FREE right now, with the model's working headroom on top.
  const ramGB = Math.round(os.totalmem() / 1e9)
  const free = os.freemem()
  const fit = [...MODELS].reverse().find((m) => ramGB >= m.ramGB && m.approxGB * 1e9 + 6e9 <= free)
  return (fit ?? MODELS[0]!).id
}

async function toDto(): Promise<LocalModelsStateDto> {
  const state = await readState()
  const models: LocalModelDto[] = []
  for (const spec of MODELS) {
    models.push({
      id: spec.id,
      label: spec.label,
      desc: spec.desc,
      approxGB: spec.approxGB,
      ramGB: spec.ramGB,
      tag: spec.tag,
      downloaded: await modelPresent(spec),
      downloading: downloads.has(spec.id),
      active: state.activeModelId === spec.id,
    })
  }
  return {
    models,
    recommendedId: recommendId(),
    ramGB: Math.round(os.totalmem() / 1e9),
    serverReady: true,
  }
}

function announce(): void {
  void toDto().then((dto) => broadcast({ type: 'localmodels:changed', state: dto }))
}

// Wired by index.ts once the vault is up: a model appearing or switching must
// re-run engine detection right away, or the connect banner keeps saying
// "no AI" until the next refocus or the 30-minute watch.
let modelsChangedHook: (() => void) | null = null
export function setModelsChangedHook(hook: () => void): void {
  modelsChangedHook = hook
}

export function registerLocalLlmIpc(): void {
  void sweepRetiredModels()
  ipcMain.handle('localmodels:state', () => toDto())
  // The chat panel calls this on open: 'none' = no downloaded model (nothing
  // to warm), otherwise kick a warm-up and report where it stands. Progress
  // arrives as localllm:warm broadcasts.
  ipcMain.handle('localllm:warm', async (): Promise<LlmWarmState | 'none'> => {
    if (warmState !== 'cold') return warmState
    const spec = await adoptDownloadedModel()
    if (!spec) return 'none'
    void warmLocalModel()
    return 'loading'
  })
  ipcMain.handle('localmodels:download', (_e, id: string) =>
    downloadModel(id).then((r) => {
      announce()
      if (r.ok) modelsChangedHook?.()
      return r
    }),
  )
  // Same pair as download, for the opposite reason: with the last brain gone
  // engine detection must re-run or the connect banner keeps claiming local AI.
  ipcMain.handle('localmodels:delete', (_e, id: string) =>
    deleteModel(id).then((r) => {
      announce()
      if (r.ok) modelsChangedHook?.()
      return r
    }),
  )
  ipcMain.handle('localmodels:cancel', (_e, id: string) => {
    downloads.get(id)?.controller.abort()
  })
  ipcMain.handle('localmodels:setActive', async (_e, id: string | null) => {
    const state = await readState()
    state.activeModelId = id ?? undefined
    await writeFile(stateFile(), JSON.stringify(state)).catch(() => undefined)
    // The worker holds the old model; drop it so the next call loads the new one.
    stopLocalServer()
    announce()
    modelsChangedHook?.()
  })
}

