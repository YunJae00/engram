import { app, ipcMain, net } from 'electron'
import { fork, type ChildProcess } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalModelDto, LocalModelsStateDto } from '../shared/types.js'
import { broadcast } from './ipc.js'
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

const MODELS: ModelSpec[] = [
  {
    id: 'gemma4-e2b',
    label: 'Gemma 4 E2B',
    file: 'gemma-4-E2B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf',
    approxGB: 2.9,
    ramGB: 8,
    tag: 'light',
    desc: 'Small and quick — for laptops with little free memory.',
  },
  {
    id: 'gemma4-e4b',
    label: 'Gemma 4 E4B',
    file: 'gemma-4-E4B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf',
    approxGB: 5.0,
    ramGB: 12,
    tag: 'korean',
    desc: 'The default — best Korean per gigabyte.',
  },
  {
    id: 'gemma4-12b',
    label: 'Gemma 4 12B',
    file: 'gemma-4-12B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-12B-it-GGUF/resolve/main/gemma-4-12B-it-Q4_K_M.gguf',
    approxGB: 7.3,
    ramGB: 16,
    tag: 'balanced',
    desc: 'Noticeably better writing — for 16GB machines.',
  },
  {
    id: 'gemma4-26b-a4b',
    label: 'Gemma 4 26B-A4B',
    file: 'gemma-4-26B-A4B-it-Q4_K_M.gguf',
    url: 'https://huggingface.co/unsloth/gemma-4-26B-A4B-it-GGUF/resolve/main/gemma-4-26B-A4B-it-Q4_K_M.gguf',
    approxGB: 15.5,
    ramGB: 32,
    tag: 'power',
    desc: 'Big-model quality at small-model speed (MoE) — for 32GB machines.',
  },
]

const IDLE_UNLOAD_MS = 45 * 60_000
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
  onPart: (chunk: Uint8Array) => void,
  signal: AbortSignal,
  onTotal: (n: number) => void,
): Promise<void> {
  // Chromium's fetch, not Node's: corporate TLS-inspecting proxies break
  // Node's fetch while the browser stack negotiates fine.
  const res = await net.fetch(url, { signal })
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  if (total > 0) onTotal(total)
  const reader = res.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) onPart(value)
  }
}

async function downloadModel(id: string): Promise<{ ok: boolean; log?: string }> {
  const spec = MODELS.find((m) => m.id === id)
  if (!spec) return { ok: false, log: 'unknown model' }
  if (downloads.has(id)) return { ok: true }
  await mkdir(modelsDir(), { recursive: true })
  const finalPath = join(modelsDir(), spec.file)
  const partPath = `${finalPath}.part`
  const controller = new AbortController()
  downloads.set(id, { controller })
  announce()
  let received = 0
  let total = spec.approxGB * 1e9
  let lastTick = 0
  try {
    const out = createWriteStream(partPath)
    await chromiumStream(
      spec.url,
      (chunk) => {
        out.write(chunk)
        received += chunk.length
        const now = Date.now()
        if (now - lastTick > 500) {
          lastTick = now
          broadcast({ type: 'localmodel:progress', id, received, total })
        }
      },
      controller.signal,
      (n) => {
        total = n
      },
    )
    await new Promise<void>((resolve, reject) => out.end((err: unknown) => (err ? reject(err) : resolve())))
    await rename(partPath, finalPath)
    broadcast({ type: 'localmodel:progress', id, received: total, total })
    return { ok: true }
  } catch (err) {
    await rm(partPath, { force: true }).catch(() => undefined)
    if (controller.signal.aborted) return { ok: false, log: 'canceled' }
    flog('localmodel-download-failed', err)
    return { ok: false, log: String(err).slice(0, 200) }
  } finally {
    downloads.delete(id)
    announce()
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

function spawnChild(): Promise<ChildProcess | null> {
  if (childReady) return childReady
  childReady = new Promise<ChildProcess | null>((resolve) => {
    let settled = false
    const proc = fork(workerPath(), [], {
      execPath: process.execPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    })
    proc.on('message', (message: { type: string; id?: number; text?: string; ms?: number; gpu?: string; message?: string }) => {
      if (message.type === 'ready') {
        if (!settled) {
          settled = true
          child = proc
          resolve(proc)
        }
        return
      }
      if (message.type === 'loaded') {
        flog('local-llm', `model loaded in ${message.ms}ms (worker, gpu: ${message.gpu ?? '?'})`)
        return
      }
      if (message.type === 'load-failed') {
        flog('local-llm-load-failed', message.message)
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
    proc.on('exit', () => {
      child = null
      childReady = null
      failAllPending('the inference process exited')
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
    // A worker that never says hello is a broken install, not a hang.
    setTimeout(() => {
      if (settled) return
      settled = true
      resolve(child)
    }, 20_000)
  })
  return childReady
}

// Warm the model without anyone waiting on it — the first question then costs
// nothing, and the load happens where it cannot freeze the UI.
export async function warmLocalModel(): Promise<void> {
  const spec = await adoptDownloadedModel()
  if (!spec) return
  const proc = await spawnChild()
  if (!proc) return
  proc.send({ type: 'load', modelPath: join(modelsDir(), spec.file), contextSize: CTX_TOKENS })
}

let inFlight: Promise<string> | null = null

export async function localComplete(
  prompt: string,
  opts: { maxTokens?: number; signal?: AbortSignal; onToken?: (text: string) => void },
): Promise<string> {
  // Serialize: local inference saturates the machine; overlapping jobs would
  // page-thrash. The librarian is serial anyway (concurrency 1).
  while (inFlight) await inFlight.catch(() => undefined)
  const work = (async () => {
    const spec = await adoptDownloadedModel()
    if (!spec) throw new Error('no local model is active')
    const proc = await spawnChild()
    if (!proc) throw new Error('the inference process could not start')
    proc.send({ type: 'load', modelPath: join(modelsDir(), spec.file), contextSize: CTX_TOKENS })
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
      proc.send({ type: 'complete', id, prompt, maxTokens: opts.maxTokens ?? 1024 })
    })
    lastUsed = Date.now()
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
function armIdleUnload(): void {
  setInterval(() => {
    if (!child || inFlight || lastUsed === 0) return
    if (Date.now() - lastUsed < IDLE_UNLOAD_MS) return
    flog('local-llm', 'idle — unloading the model')
    child.send({ type: 'unload' })
    lastUsed = 0
  }, 60_000)
}
armIdleUnload()

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

// Kept name from the server era — now it stops the inference process.
export function stopLocalServer(): void {
  const proc = child
  child = null
  childReady = null
  failAllPending('shutting down')
  proc?.kill('SIGKILL')
}

// ── Hardware probe for the recommendation badge ─────────────────────────
function recommendId(): string {
  const ramGB = Math.round(os.totalmem() / 1e9)
  const fit = [...MODELS].reverse().find((m) => ramGB >= m.ramGB)
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

export function registerLocalLlmIpc(): void {
  ipcMain.handle('localmodels:state', () => toDto())
  ipcMain.handle('localmodels:download', (_e, id: string) => downloadModel(id).then((r) => (announce(), r)))
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
  })
}

