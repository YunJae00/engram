import { Worker } from 'node:worker_threads'
import type { CodexOptions, Input, ThreadOptions } from '@openai/codex-sdk'
import type { ReasoningEffort } from 'core'

export interface CodexTurn { options: CodexOptions; thread: Omit<ThreadOptions, 'modelReasoningEffort'> & { modelReasoningEffort?: ReasoningEffort }; input: Input; outputSchema?: unknown }

export function runCodexTurn(request: CodexTurn, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./codex-worker.js', import.meta.url), { workerData: request })
    const abort = () => worker.postMessage('abort')
    signal.addEventListener('abort', abort, { once: true })
    worker.once('message', (reply: { text?: string; error?: string }) => {
      if (reply.error !== undefined) reject(new Error(reply.error))
      else resolve(reply.text ?? '')
    })
    worker.once('error', reject)
    worker.once('exit', () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('The model worker closed before returning a result.'))
    })
  })
}
