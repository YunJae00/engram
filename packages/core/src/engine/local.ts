import { ENGINE_BUDGETS, type Engine, type EngineDetection, type EngineEvent, type EngineJobInput } from './types.js'

export interface LocalTransport {
  // One prompt in, the final text out. Reject → error event (classified by
  // message below); respect the signal for cancellation. `onToken` receives
  // the answer in pieces as it is generated — optional, because the CLI's
  // default transport has nothing to stream. `jsonSchema` constrains decoding
  // to that schema when the runtime supports grammars.
  complete(
    prompt: string,
    opts: {
      maxTokens?: number
      signal?: AbortSignal
      onToken?: (text: string) => void
      jsonSchema?: object
      // 'fast' lets the host answer with a smaller downloaded brain when the
      // machine cannot spare the flagship — errands ride this.
      modelHint?: 'fast'
    },
  ): Promise<string>
  // Cheap presence check for detection: a model is chosen, on disk, and the
  // runtime can be had. MUST NOT load gigabytes — detection polls this on
  // focus and every few minutes.
  configured(): Promise<boolean>
  // Human-readable model label for diagnostics ("Gemma 4 E2B").
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
    // Cancelled before we even started: the listener below would never fire.
    if (job.signal?.aborted) {
      clearTimeout(timer)
      return
    }
    job.signal?.addEventListener('abort', onAbort, { once: true })

    // The transport hands tokens to a callback; this queue carries them into
    // the generator in order, so none are lost between yields.
    const queue: string[] = []
    let wake: (() => void) | null = null
    let settled = false
    let answer = ''
    let failure: unknown = null
    const ring = () => {
      const fn = wake
      wake = null
      fn?.()
    }
    const work = this.transport
      .complete(job.prompt, {
        signal: controller.signal,
        ...(job.jsonSchema ? { jsonSchema: job.jsonSchema } : {}),
        ...(job.modelHint === 'fast' ? { modelHint: 'fast' as const } : {}),
        onToken: (text) => {
          if (text) queue.push(text)
          ring()
        },
      })
      .then((text) => {
        answer = text
      })
      .catch((err: unknown) => {
        failure = err ?? new Error('local model failed')
      })
      .finally(() => {
        settled = true
        ring()
      })

    try {
      let streamed = ''
      for (;;) {
        while (queue.length > 0) {
          const chunk = queue.shift()!
          streamed += chunk
          yield { type: 'token', text: chunk }
        }
        if (settled) break
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
      await work
      if (failure !== null) {
        // A caller's cancel ends silently — same contract as the claude adapter.
        if (job.signal?.aborted) return
        const timedOut = controller.signal.aborted
        yield {
          type: 'error',
          message: timedOut
            ? `[engram] timed out after ${timeoutMs}ms`
            : `local model failed: ${String(failure).slice(0, 200)}`,
          kind: timedOut ? 'timeout' : 'crash',
        }
        return
      }
      const text = answer.trim() ? answer : streamed
      if (!text.trim()) {
        yield { type: 'error', message: 'local model returned an empty answer', kind: 'unknown' }
        return
      }
      // Nothing streamed (a transport without token support) still owes the
      // caller the answer as one piece.
      if (!streamed) yield { type: 'token', text }
      yield { type: 'result', text }
    } finally {
      clearTimeout(timer)
      job.signal?.removeEventListener('abort', onAbort)
    }
  }
}
