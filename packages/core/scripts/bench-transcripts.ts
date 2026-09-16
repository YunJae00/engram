import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { appendBotTurn, readBotTranscript } from '../src/bots.js'
import { vaultPaths } from '../src/vault.js'

const tmp = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(tmp, { recursive: true })
const root = await mkdtemp(join(tmp, 'storage-bench-'))
const paths = vaultPaths(root)
const dir = join(paths.cache, 'bot-chats')
await mkdir(dir, { recursive: true })
const turns = Array.from({ length: 400 }, (_, i) => ({ role: 'assistant' as const, text: `${i}: ${'A detailed answer with Korean 내용. '.repeat(90)}`, at: '2026-01-01' }))
const seed = turns.map(turn => JSON.stringify(turn)).join('\n') + '\n'
for (const id of ['before', 'after']) await writeFile(join(dir, `${id}.jsonl`), seed)
async function oldRead(id: string, limit = 400) {
  const raw = await readFile(join(dir, `${id}.jsonl`), 'utf8')
  const rows = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { const parsed = JSON.parse(line); if ((parsed?.role === 'user' || parsed?.role === 'assistant') && typeof parsed?.text === 'string') rows.push(parsed) } catch { /* Match the previous reader's corrupt-line handling. */ }
  }
  return rows.slice(-limit)
}
async function measure(work: () => Promise<unknown>) {
  await work()
  const times: number[] = []
  for (let i = 0; i < 15; i++) { const start = performance.now(); await work(); times.push(performance.now() - start) }
  times.sort((a, b) => a - b)
  return Math.round(times[7]! * 100) / 100
}
const beforeRead = await measure(() => oldRead('before', 1))
const afterRead = await measure(() => readBotTranscript(paths, 'after', 1))
let oldBytes = 0, newBytes = 0
const startOld = performance.now()
for (let i = 0; i < 25; i++) {
  const rows = await oldRead('before', 399)
  const data = [...rows, { role: 'user', text: `New question ${i}`, at: '2026-01-02' }].map(turn => JSON.stringify(turn)).join('\n') + '\n'
  oldBytes += Buffer.byteLength(data)
  await writeFile(join(dir, 'before.jsonl'), data)
}
const beforeAppend = performance.now() - startOld
const startNew = performance.now()
for (let i = 0; i < 25; i++) {
  const turn = { role: 'user' as const, text: `New question ${i}`, at: '2026-01-02' }
  newBytes += Buffer.byteLength(JSON.stringify(turn) + '\n')
  await appendBotTurn(paths, 'after', turn)
}
const afterAppend = performance.now() - startNew
const lastTurnEqual = JSON.stringify((await oldRead('before', 1))[0]) === JSON.stringify((await readBotTranscript(paths, 'after', 1))[0])
if (!lastTurnEqual) throw new Error('Transcript benchmark changed the final message')
console.log(JSON.stringify({ root, seedBytes: Buffer.byteLength(seed), previewMedianMs: { before: beforeRead, after: afterRead }, append25Ms: { before: Math.round(beforeAppend), after: Math.round(afterAppend) }, logicalAppendBytes: { before: oldBytes, after: newBytes }, lastTurnEqual }, null, 2))
