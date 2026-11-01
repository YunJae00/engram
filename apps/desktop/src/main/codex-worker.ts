import { createInterface } from 'node:readline'
import { Codex, type ThreadOptions } from '@openai/codex-sdk'
import type { CodexTurn } from './codex-turn.js'

const abort = new AbortController()
process.once('SIGTERM', () => abort.abort())
const lines = createInterface({ input: process.stdin })
lines.once('line', async line => {
  lines.close()
  try {
    const request = JSON.parse(line) as CodexTurn
    const thread = new Codex(request.options).startThread(request.thread as ThreadOptions)
    const turn = await thread.run(request.input, { outputSchema: request.outputSchema, signal: abort.signal })
    process.stdout.write(JSON.stringify({ text: turn.finalResponse }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) + '\n')
  }
})
