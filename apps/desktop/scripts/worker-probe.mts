// The inference worker on its own: load, then two answers, every message
// timestamped. Isolates the worker from the app when a step stops answering.
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const worker = fileURLToPath(new URL('../out/main/llm-worker.js', import.meta.url))
const electron = fileURLToPath(new URL('../node_modules/electron/dist/electron.exe', import.meta.url))
const model = join(process.env['APPDATA']!, 'desktop', 'models', 'gguf', 'gemma-4-E2B-it-Q4_K_M.gguf')
if (!existsSync(model)) throw new Error('no model at ' + model)
const t0 = Date.now()
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`
const proc = fork(worker, [], { execPath: electron, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
let progress = 0
proc.on('message', (m: Record<string, unknown>) => {
  if (m['type'] === 'progress') { progress++; if (progress % 5 === 1) console.log(at(), 'progress', JSON.stringify(m)); return }
  if (m['type'] === 'chunk') return
  console.log(at(), JSON.stringify(m).slice(0, 300))
  if (m['type'] === 'ready') proc.send({ type: 'load', modelPath: model, contextSize: 4096, plan: { gpuLayers: 0, vramPadding: 0, mode: 'cpu', lock: true } })
  if (m['type'] === 'loaded') {
    const schema = {
      oneOf: [
        { type: 'object', properties: { tool: { const: 'search_memory' }, args: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
        { type: 'object', properties: { tool: { const: 'answer' }, args: { type: 'object', properties: { text: { type: 'string' } } } } },
      ],
    }
    proc.send({ type: 'complete', id: 1, prompt: 'You are working on a task for the person you assist.\nTask: what did we decide about deploys?\n\nJOB: COMET-STEP\nPick exactly ONE tool.\nTools:\n- search_memory: search the vault - args: {"query": "..."}\n- answer: you have what you need - args: {"text": "..."}\nOutput only JSON: {"tool": "...", "args": {...}}', maxTokens: 320, jsonSchema: schema })
  }
  if (m['type'] === 'done' && m['id'] === 1) proc.send({ type: 'complete', id: 2, prompt: 'Say hello in one short sentence.', maxTokens: 60 })
  if ((m['type'] === 'done' && m['id'] === 2) || m['type'] === 'failed') { proc.kill(); process.exit(0) }
})
setTimeout(() => { console.log(at(), 'GAVE UP - no answer'); proc.kill(); process.exit(1) }, 240_000)
