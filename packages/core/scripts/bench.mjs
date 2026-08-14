// Synthetic-vault benchmark for the core note pipeline.
//
//   node scripts/bench.mjs            # from packages/core
//   BENCH_N=500 node scripts/bench.mjs
//
// Generates a deterministic vault of BENCH_N (~1KB) notes under
// tmp/bench-vault-<N> (reused if already present) and times the hot paths:
// full loadNotes, NoteStore.open, the legacy buildIndex+query path, the
// incremental store.search, and a single store.applyFile. Pure Node; the core
// TypeScript is loaded through tsx's ESM loader (already a devDependency).
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { register } from 'tsx/esm/api'

register()

const { loadNotes } = await import('../src/notes.ts')
const { serializeNote } = await import('../src/schema.ts')
const { buildIndex, searchIndex } = await import('../src/search.ts')
const { NoteStore } = await import('../src/store.ts')

const N = Number(process.env.BENCH_N ?? '2000')
const QUERY = 'pipeline'
const VOCAB = [
  'deployment', 'service', 'latency', 'config', 'rollback', 'incident',
  'database', 'schedule', 'budget', 'endpoint', 'retry', 'cache',
  'token', 'metric', 'alert', 'runbook',
]

const scriptDir = dirname(fileURLToPath(import.meta.url))
const tmpRoot = join(scriptDir, '..', '..', '..', 'tmp')
const vaultDir = join(tmpRoot, `bench-vault-${N}`)
const notesDir = join(vaultDir, 'workspace', 'notes')
// NoteStore.open and loadNotes only read paths.notes, so a minimal shape is
// enough — no git init or full vault scaffold needed for a bench.
const paths = { notes: notesDir }

const BASE = Date.parse('2026-01-01T00:00:00Z')
const noteId = (i) => `note-${String(i).padStart(6, '0')}`

function makeBody(i) {
  const topic = VOCAB[i % VOCAB.length]
  const tag = i % 5 === 0 ? 'pipeline' : 'workflow'
  let body = `# Note ${i} — ${topic} runbook\n\n` +
    `This ${tag} note covers ${topic} and ${VOCAB[(i * 7) % VOCAB.length]}.\n\n`
  let k = 0
  while (body.length < 1000) {
    const w = VOCAB[(i + k * 3) % VOCAB.length]
    body += `- step ${k}: verify ${w} threshold and record token-${i}-${k}.\n`
    k++
  }
  return body
}

function makeMarkdown(i) {
  const created = new Date(BASE + i * 60_000).toISOString()
  const note = {
    front: {
      id: noteId(i),
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      created,
      updated: created,
    },
    body: makeBody(i),
  }
  return serializeNote(note)
}

async function ensureVault() {
  await mkdir(notesDir, { recursive: true })
  let existing = []
  try {
    existing = (await readdir(notesDir)).filter((f) => f.endsWith('.md'))
  } catch {
    existing = []
  }
  if (existing.length === N) return false // reuse
  const writes = []
  for (let i = 0; i < N; i++) writes.push(writeFile(join(notesDir, `${noteId(i)}.md`), makeMarkdown(i)))
  await Promise.all(writes)
  return true
}

async function timed(fn) {
  const s = performance.now()
  const value = await fn()
  return { ms: performance.now() - s, value }
}

async function main() {
  const generated = await ensureVault()

  const load = await timed(() => loadNotes(paths))
  const notes = load.value

  const opened = await timed(() => NoteStore.open(paths))
  const store = opened.value

  const legacy = await timed(async () => {
    const idx = buildIndex(notes)
    return searchIndex(idx, QUERY)
  })

  const search = await timed(() => store.search(QUERY))

  // Rewrite one note's body on disk (untimed), then time the incremental fold.
  const changeId = noteId(0)
  const changePath = join(notesDir, `${changeId}.md`)
  const current = store.get(changeId)
  const updated = new Date(BASE + 999 * 60_000).toISOString()
  await writeFile(
    changePath,
    serializeNote({ front: { ...current.front, updated }, body: `${makeBody(0)}\nedited-${updated}\n` }),
  )
  const apply = await timed(() => store.applyFile('change', changePath))

  const rows = [
    ['full loadNotes (cold read)', load.ms, `${notes.length} notes`],
    ['NoteStore.open', opened.ms, `${store.getAll().length} notes`],
    ['legacy buildIndex + 1 query', legacy.ms, `${legacy.value.length} hits`],
    ['store.search (1 query)', search.ms, `${search.value.length} hits`],
    ['store.applyFile (1 file)', apply.ms, `${apply.value.upserts.length} upsert`],
  ]

  console.log(`\nEngram core bench — N=${N} (${generated ? 'generated' : 'reused'} ${vaultDir})\n`)
  const labelW = Math.max(...rows.map((r) => r[0].length))
  for (const [label, ms, note] of rows) {
    console.log(`  ${label.padEnd(labelW)}  ${ms.toFixed(2).padStart(10)} ms   ${note}`)
  }
  console.log('')
}

await main()
