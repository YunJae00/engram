import { parentPort, workerData } from 'node:worker_threads'
import { Codex, type ThreadOptions } from '@openai/codex-sdk'
import type { CodexTurn } from './codex-turn.js'

const port = parentPort!
const request = workerData as CodexTurn
const abort = new AbortController()
port.on('message', () => abort.abort())
try {
  // Runtime-discovered effort levels can precede the SDK's static union.
  const thread = new Codex(request.options).startThread(request.thread as ThreadOptions)
  const turn = await thread.run(request.input, { outputSchema: request.outputSchema, signal: abort.signal })
  port.postMessage({ text: turn.finalResponse })
} catch (error) {
  port.postMessage({ error: error instanceof Error ? error.message : String(error) })
} finally { port.close() }
