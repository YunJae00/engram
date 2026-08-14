// Inference host. Runs as a separate process so loading a multi-GB model
// (20-40s of mmap + GPU init, measured) never blocks the windows. The parent
// owns policy; this file owns the model and answers one request at a time.

interface LoadRequest {
  type: 'load'
  modelPath: string
  contextSize: number
}

interface CompleteRequest {
  type: 'complete'
  id: number
  prompt: string
  maxTokens: number
}

type WorkerRequest = LoadRequest | CompleteRequest | { type: 'unload' }

interface Engine {
  llama: { dispose(): Promise<void> }
  model: {
    dispose(): Promise<void>
    createContext(opts: { contextSize: number }): Promise<{ dispose(): Promise<void>; getSequence(): unknown }>
  }
  path: string
  contextSize: number
}

let engine: Engine | null = null
let loading: Promise<Engine | null> | null = null

const send = (message: unknown): void => {
  process.send?.(message)
}

async function ensure(path: string, contextSize: number): Promise<Engine | null> {
  if (engine && engine.path === path) return engine
  if (loading) return loading
  loading = (async () => {
    try {
      if (engine) {
        await engine.model.dispose().catch(() => undefined)
        await engine.llama.dispose().catch(() => undefined)
        engine = null
      }
      const t0 = Date.now()
      const nlc = (await import('node-llama-cpp')) as unknown as {
        getLlama(): Promise<Engine['llama'] & { loadModel(o: { modelPath: string }): Promise<Engine['model']> }>
      }
      const llama = await nlc.getLlama()
      const model = await llama.loadModel({ modelPath: path })
      engine = { llama, model, path, contextSize }
      send({ type: 'loaded', ms: Date.now() - t0, gpu: String((llama as { gpu?: unknown }).gpu ?? 'unknown') })
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

async function complete(req: CompleteRequest, path: string, contextSize: number): Promise<void> {
  try {
    const ready = await ensure(path, contextSize)
    if (!ready) throw new Error('no local model is active')
    const nlc = (await import('node-llama-cpp')) as unknown as {
      LlamaChatSession: new (o: { contextSequence: unknown; chatWrapper: unknown }) => {
        prompt(text: string, o?: { maxTokens?: number }): Promise<string>
      }
      // Explicit wrapper on purpose: auto-detection does not know this model
      // family yet and silently yields empty answers.
      GemmaChatWrapper: new () => unknown
    }
    const context = await ready.model.createContext({ contextSize })
    try {
      const session = new nlc.LlamaChatSession({
        contextSequence: context.getSequence(),
        chatWrapper: new nlc.GemmaChatWrapper(),
      })
      const text = await session.prompt(req.prompt, { maxTokens: req.maxTokens })
      send({ type: 'done', id: req.id, text })
    } finally {
      await context.dispose().catch(() => undefined)
    }
  } catch (err) {
    send({ type: 'failed', id: req.id, message: String((err as Error).message ?? err) })
  }
}

let modelPath = ''
let ctxTokens = 4_096

process.on('message', (raw: unknown) => {
  const req = raw as WorkerRequest
  if (req.type === 'load') {
    modelPath = req.modelPath
    ctxTokens = req.contextSize
    void ensure(modelPath, ctxTokens)
    return
  }
  if (req.type === 'unload') {
    const held = engine
    engine = null
    if (held) {
      void held.model.dispose().catch(() => undefined)
      void held.llama.dispose().catch(() => undefined)
    }
    return
  }
  if (req.type === 'complete') void complete(req, modelPath, ctxTokens)
})

send({ type: 'ready' })
