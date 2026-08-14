import { ENGINE_BUDGETS, type Engine, type EngineDetection, type EngineEvent, type EngineJobInput } from './types.js'

export interface LocalTransport {
  // One prompt in, the final text out. Reject → error event (classified by
  // message below); respect the signal for cancellation.
  complete(prompt: string, opts: { maxTokens?: number; signal?: AbortSignal }): Promise<string>
  // Cheap presence check for detection: a model is chosen, on disk, and the
  // runtime can be had. MUST NOT load gigabytes — detection polls this on
  // focus and every few minutes.
  configured(): Promise<boolean>
  // Human-readable model label for diagnostics ("Gemma 4 E4B").
  label?: string
}

export class LocalAdapter implements Engine {
  readonly id = 'local' as const

  constructor(private readonly transport: LocalTransport) {}

  // "loggedIn" is meaningless for a local model and is always true when
  // present — no surface may ask a local user to log in to their own machine.
  async detect(): Promise<EngineDetection> {
    const ok = await this.transport.configured().catch(() => false)
    return { installed: ok, loggedIn: ok, conclusive: true }
  }

  async *run(job: EngineJobInput): AsyncIterable<EngineEvent> {
    const timeoutMs = job.timeoutMs ?? ENGINE_BUDGETS.job
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const onAbort = () => controller.abort(new Error('canceled'))
    job.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const text = await this.transport.complete(job.prompt, { signal: controller.signal })
      if (!text.trim()) {
        yield { type: 'error', message: 'local model returned an empty answer', kind: 'unknown' }
        return
      }
      yield { type: 'token', text }
      yield { type: 'result', text }
    } catch (err) {
      // A caller's cancel ends silently — same contract as the claude adapter.
      if (job.signal?.aborted) return
      const timedOut = controller.signal.aborted
      yield {
        type: 'error',
        message: timedOut ? `[engram] timed out after ${timeoutMs}ms` : `local model failed: ${String(err).slice(0, 200)}`,
        kind: timedOut ? 'timeout' : 'crash',
      }
    } finally {
      clearTimeout(timer)
      job.signal?.removeEventListener('abort', onAbort)
    }
  }
}
