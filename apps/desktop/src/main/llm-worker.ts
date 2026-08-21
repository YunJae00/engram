// Inference host. Runs as a separate process so loading a multi-GB model
// (20-40s of mmap + GPU init, measured) never blocks the windows. The parent
// owns policy; this file owns the model and answers one request at a time.

interface LoadRequest {
  type: 'load'
  modelPath: string
  contextSize: number
  // Where the weights may live, decided by the parent from real free memory.
  // 'auto' offloads what fits inside vramPadding; 0 keeps everything on the
  // CPU side, where mmap leaves the pages evictable instead of pinned.
  plan?: { gpuLayers: 'auto' | 0; vramPadding: number; mode: string }
}

interface CompleteRequest {
  type: 'complete'
  id: number
  prompt: string
  maxTokens: number
  jsonSchema?: object
}

type WorkerRequest = LoadRequest | CompleteRequest | { type: 'abort'; id: number } | { type: 'unload' }

interface LlamaContext {
  dispose(): Promise<void>
  getSequence(): unknown
}

// Opaque grammar handle — a LlamaJsonSchemaGrammar (which extends LlamaGrammar,
// the type prompt() expects for its `grammar` option). Never constructed here.
type LlamaGrammar = { __grammar: never }

interface PromptOptions {
  maxTokens?: number
  signal?: AbortSignal
  stopOnAbortSignal?: boolean
  onTextChunk?: (text: string) => void
  grammar?: LlamaGrammar
}

interface ChatSession {
  prompt(text: string, o?: PromptOptions): Promise<string>
  resetChatHistory?: () => void
}

interface Engine {
  llama: {
    dispose(): Promise<void>
    createGrammarForJsonSchema(schema: object): Promise<LlamaGrammar>
  }
  model: {
    dispose(): Promise<void>
    createContext(opts: { contextSize: number }): Promise<LlamaContext>
  }
  path: string
  contextSize: number
}

let engine: Engine | null = null
let loading: Promise<Engine | null> | null = null

const send = (message: unknown): void => {
  process.send?.(message)
}

interface LoadPlan {
  gpuLayers: 'auto' | 0
  vramPadding: number
  mode: string
}

const CPU_ONLY: LoadPlan = { gpuLayers: 0, vramPadding: 0, mode: 'cpu' }

async function loadWith(path: string, contextSize: number, plan: LoadPlan): Promise<Engine> {
  const nlc = (await import('node-llama-cpp')) as unknown as {
    getLlama(o?: { vramPadding?: number; ramPadding?: number }): Promise<
      Engine['llama'] & {
        loadModel(o: {
          modelPath: string
          gpuLayers: 'auto' | number
          useMmap: boolean
          useMlock: boolean
        }): Promise<Engine['model']>
      }
    >
  }
  const llama = await nlc.getLlama({
    ...(plan.vramPadding > 0 ? { vramPadding: plan.vramPadding } : {}),
    ramPadding: 2e9,
  })
  // mmap always, mlock never: weights the OS can evict under pressure are the
  // difference between a slow answer and a frozen machine.
  const model = await llama.loadModel({ modelPath: path, gpuLayers: plan.gpuLayers, useMmap: true, useMlock: false })
  return { llama, model, path, contextSize }
}

async function ensure(path: string, contextSize: number, plan: LoadPlan): Promise<Engine | null> {
  if (engine && engine.path === path) return engine
  if (loading) return loading
  loading = (async () => {
    try {
      if (engine) {
        await engine.model.dispose().catch(() => undefined)
        await engine.llama.dispose().catch(() => undefined)
        engine = null
      }
      forgetGrammars()
      const t0 = Date.now()
      let used = plan
      try {
        engine = await loadWith(path, contextSize, plan)
      } catch (err) {
        // The GPU plan can still lose a race with other allocations. CPU-only
        // cannot pin anything, so it is always worth one retry before failing.
        if (plan.gpuLayers === 0) throw err
        used = CPU_ONLY
        engine = await loadWith(path, contextSize, used)
      }
      // Allocate the context here too: it costs seconds, and paying that during
      // the background warm-up means the first question does not.
      await prepareSession(engine, contextSize).catch(() => undefined)
      send({
        type: 'loaded',
        ms: Date.now() - t0,
        gpu: String((engine.llama as { gpu?: unknown }).gpu ?? 'unknown'),
        mode: used.mode,
        layers: (engine.model as { gpuLayers?: number }).gpuLayers ?? -1,
      })
      return engine
    } catch (err) {
      send({ type: 'load-failed', message: String((err as Error).message ?? err) })
      return null
    } finally {
      loading = null
    }
  })()
  return loading
}

// One context, one sequence, one session — all reused. Allocating a 4k-token
// KV cache per question was pure overhead, and a context only ever hands out a
// limited number of sequences, so taking a fresh one per answer died on the
// second question with 'No sequences left'. The session's history is cleared
// instead; the caller sends its own history in the prompt anyway.
let context: LlamaContext | null = null
let session: ChatSession | null = null

async function prepareSession(ready: Engine, contextSize: number): Promise<ChatSession> {
  const nlc = (await import('node-llama-cpp')) as unknown as {
    LlamaChatSession: new (o: { contextSequence: unknown; chatWrapper: unknown }) => ChatSession
    // Explicit wrapper on purpose: auto-detection does not know this model
    // family yet and silently yields empty answers.
    GemmaChatWrapper: new () => unknown
  }
  if (!context) context = await ready.model.createContext({ contextSize })
  if (!session) {
    session = new nlc.LlamaChatSession({
      contextSequence: context.getSequence(),
      chatWrapper: new nlc.GemmaChatWrapper(),
    })
  }
  return session
}

// Live cancels, so a user who presses Stop stops the GPU rather than just
// hiding the answer they are still paying for.
const running = new Map<number, AbortController>()

// Compiling a grammar walks the whole schema; the errand phases and the tool
// loop reuse a handful of schemas over and over, so keyed by the schema text
// they compile once. A grammar belongs to the runtime that made it, so the
// cache is emptied whenever the model is unloaded or reloaded — reusing one
// across instances throws mid-answer, which is how a tool loop that spans an
// idle unload died.
const grammars = new Map<string, LlamaGrammar>()

function forgetGrammars(): void {
  grammars.clear()
}

async function grammarFor(ready: Engine, schema: object): Promise<LlamaGrammar | null> {
  const key = JSON.stringify(schema)
  const cached = grammars.get(key)
  if (cached) return cached
  try {
    const grammar = await ready.llama.createGrammarForJsonSchema(schema)
    grammars.set(key, grammar)
    return grammar
  } catch {
    // Fall back to unconstrained prompting: the prompt already asks for JSON and
    // the caller validates the result, so a bad schema costs a retry, not a crash.
    return null
  }
}

async function complete(req: CompleteRequest, path: string, contextSize: number): Promise<void> {
  const canceller = new AbortController()
  running.set(req.id, canceller)
  try {
    const ready = await ensure(path, contextSize, loadPlan)
    if (!ready) throw new Error('no local model is active')
    const warm = session !== null
    const chat = await prepareSession(ready, contextSize)
    if (warm) chat.resetChatHistory?.()
    const grammar = req.jsonSchema ? await grammarFor(ready, req.jsonSchema) : null
    // Streamed, not batched: the answer takes tens of seconds locally, and
    // watching it arrive is the difference between slow and broken.
    const text = await chat.prompt(req.prompt, {
      maxTokens: req.maxTokens,
      signal: canceller.signal,
      stopOnAbortSignal: true,
      onTextChunk: (chunk) => send({ type: 'chunk', id: req.id, text: chunk }),
      ...(grammar ? { grammar } : {}),
    })
    // Template tokens sometimes survive generation on this family and leak
    // into answers as "</start_of_turn>" — strip them where the model lives.
    send({ type: 'done', id: req.id, text: text.replace(/<\/?(?:start|end)_of_turn>/g, '') })
  } catch (err) {
    // A context that failed mid-answer may be poisoned; drop it so the next
    // question starts clean.
    const held = context
    context = null
    session = null
    void held?.dispose().catch(() => undefined)
    send({ type: 'failed', id: req.id, message: String((err as Error).message ?? err) })
  } finally {
    running.delete(req.id)
  }
}

let modelPath = ''
let ctxTokens = 4_096
let loadPlan: LoadPlan = CPU_ONLY

process.on('message', (raw: unknown) => {
  const req = raw as WorkerRequest
  if (req.type === 'load') {
    modelPath = req.modelPath
    ctxTokens = req.contextSize
    loadPlan = req.plan ?? CPU_ONLY
    void ensure(modelPath, ctxTokens, loadPlan)
    return
  }
  if (req.type === 'abort') {
    running.get(req.id)?.abort()
    return
  }
  if (req.type === 'unload') {
    const heldCtx = context
    context = null
    session = null
    void heldCtx?.dispose().catch(() => undefined)
    const held = engine
    engine = null
    forgetGrammars()
    if (held) {
      void held.model.dispose().catch(() => undefined)
      void held.llama.dispose().catch(() => undefined)
    }
    return
  }
  if (req.type === 'complete') void complete(req, modelPath, ctxTokens)
})

// This process exists only to answer the app. When the app goes without
// stopping it — a crash, a force quit, an update that replaces the binary —
// the IPC channel closes and nothing will ever arrive again, but nothing ends
// the process either: it stays resident, spinning on the dead channel, and a
// machine can collect one of these per crash until it is rebooted. Tying the
// worker's life to the channel is what makes the app's exit final.
process.on('disconnect', () => process.exit(0))

process.on('uncaughtException', (err: Error) => {
  send({ type: 'load-failed', message: `worker crashed: ${err.message}` })
})
process.on('unhandledRejection', (err: unknown) => {
  send({ type: 'load-failed', message: `worker rejected: ${String((err as Error)?.message ?? err)}` })
})

send({ type: 'ready' })
