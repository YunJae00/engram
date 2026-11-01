import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { CodexOptions, Input, ThreadOptions } from '@openai/codex-sdk'
import type { ReasoningEffort } from 'core'
import { ProcessClient } from './process-client.js'

export interface CodexTurn { options: CodexOptions; thread: Omit<ThreadOptions, 'modelReasoningEffort'> & { modelReasoningEffort?: ReasoningEffort }; input: Input; outputSchema?: unknown }

export function runCodexTurn(request: CodexTurn, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = new ProcessClient(process.execPath, [fileURLToPath(new URL('./codex-worker.js', import.meta.url))], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, signal, killTree: true,
    })
    child.stderr.resume()
    const lines = createInterface({ input: child.stdout })
    let settled = false
    const finish = (error?: Error, text = '') => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', abort)
      lines.close(); child.kill()
      if (error) reject(error)
      else resolve(text)
    }
    const abort = () => finish(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', error => finish(error))
    child.stdin.on('error', error => finish(error))
    lines.on('error', error => finish(error))
    child.once('close', () => finish(new Error('The model process closed before returning a result.')))
    lines.on('line', line => {
      try {
        const reply = JSON.parse(line) as { text?: unknown; error?: unknown }
        if (typeof reply.error === 'string') finish(new Error(reply.error))
        else if (typeof reply.text === 'string') finish(undefined, reply.text)
        else finish(new Error('The model process returned an invalid response.'))
      } catch { finish(new Error('The model process returned an invalid response.')) }
    })
    if (signal.aborted) { abort(); return }
    child.stdin.end(JSON.stringify(request) + '\n')
  })
}
