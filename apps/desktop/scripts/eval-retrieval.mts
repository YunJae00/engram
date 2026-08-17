// Retrieval quality harness over the golden set (golden-set.mts). Headless —
// no Electron. Mirrors the chat retrieval path in src/main/ipc.ts stage by
// stage so every layer gets its own score and a regression names its layer:
//   lexical   minisearch + CJK bigrams          (store.search)
//   semantic  bge-m3 cosine, prod floor          (semanticQuery)
//   hybrid    reciprocal-rank fusion             (hybridMerge)
//   full      + activation rerank + spreading    (buildRetrievedContext)
// The embedding model, pooling, dtype and the vector-index file format are
// exactly production's, so numbers here transfer to the app.
//
// Run from apps/desktop:
//   ../../packages/core/node_modules/.bin/tsx scripts/eval-retrieval.mts
// First run downloads bge-m3 (~600MB) into tmp/hf-cache; later runs reuse the
// vault's .engram vector index and skip everything unchanged.
import {
  activationRerank,
  applyEmbeddings,
  buildIndex,
  cosineTopK,
  createNote,
  embedDigestOf,
  embedTextOf,
  emptyVectorIndex,
  hybridMerge,
  initVault,
  loadNotes,
  loadVectorIndex,
  saveVectorIndex,
  searchIndex,
  spreadActivation,
  staleForEmbedding,
  SEMANTIC_MIN_SCORE,
  type Note,
  type SearchHit,
  type VectorIndex,
} from 'core'
import { mkdir, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { GOLDEN_NOTES, GOLDEN_QUERIES, type GoldenQuery } from './golden-set.mts'

const ROOT = fileURLToPath(new URL('../../../tmp/golden-vault/', import.meta.url))
const HF_CACHE = fileURLToPath(new URL('../../../tmp/hf-cache/', import.meta.url))
const MODEL = 'Xenova/bge-m3'
// Mirrors ipc.ts: CHAT_RETRIEVE_LIMIT / CHAT_NEIGHBOR_LIMIT.
const RETRIEVE = 8
const NEIGHBORS = 6
const NOW = new Date('2026-08-17T12:00:00Z')

type Mode = 'lexical' | 'semantic' | 'hybrid' | 'full'
const MODES: Mode[] = ['lexical', 'semantic', 'hybrid', 'full']

interface Scored {
  ranked: string[] // ordered candidate ids (the retrieval list)
  context: string[] // what the chat model would actually see (full mode adds neighbours)
}

async function buildVault(): Promise<Note[]> {
  await rm(ROOT, { recursive: true, force: true })
  await mkdir(ROOT, { recursive: true })
  const paths = await initVault(ROOT, { git: false })
  for (const seed of GOLDEN_NOTES) {
    await createNote(
      paths,
      {
        id: seed.id,
        body: seed.body,
        type: seed.type,
        decay: seed.decay,
        derived_from: seed.derived_from,
      },
      new Date(seed.date),
    )
  }
  return loadNotes(paths)
}

async function ensureEmbeddings(notes: Note[]): Promise<{ index: VectorIndex; embedQuery: (q: string) => Promise<Float32Array> }> {
  // Persist vectors OUTSIDE the vault (the vault is wiped each run; the
  // embeddings only depend on note content digests, which are stable).
  // saveVectorIndex/loadVectorIndex only touch paths.cache.
  const cacheDir = fileURLToPath(new URL('../../../tmp/golden-vectors/', import.meta.url))
  const paths = { cache: cacheDir } as unknown as Parameters<typeof loadVectorIndex>[0]
  await mkdir(cacheDir, { recursive: true })
  let index = (await loadVectorIndex(paths, MODEL)) ?? null
  const tf = await import('@huggingface/transformers')
  tf.env.cacheDir = HF_CACHE
  let pipe: ((texts: string[], opts: object) => Promise<{ dims: number[]; data: Float32Array | number[] }>) | null = null
  const ensurePipe = async () => {
    if (pipe) return
    process.stderr.write(`loading ${MODEL} (first run downloads ~600MB)...\n`)
    // Same knobs as src/main/semantic.ts loadExtractor().
    pipe = (await tf.pipeline('feature-extraction', MODEL, {
      dtype: 'q8',
      session_options: { intraOpNumThreads: 2, interOpNumThreads: 1 },
    })) as unknown as typeof pipe
  }
  const embed = async (texts: string[]): Promise<Float32Array[]> => {
    await ensurePipe()
    const out = await pipe!(texts, { pooling: 'cls', normalize: true })
    const dim = out.dims[out.dims.length - 1]!
    const data = out.data instanceof Float32Array ? out.data : Float32Array.from(out.data)
    return texts.map((_, i) => data.subarray(i * dim, (i + 1) * dim).slice())
  }
  const liveIds = new Set(notes.map((n) => n.front.id))
  if (!index) {
    const probe = await embed(['probe'])
    index = emptyVectorIndex(MODEL, probe[0]!.length)
  }
  const stale = staleForEmbedding(notes, index)
  if (stale.length > 0) {
    process.stderr.write(`embedding ${stale.length} notes...\n`)
    const BATCH = 8
    for (let i = 0; i < stale.length; i += BATCH) {
      const batch = stale.slice(i, i + BATCH)
      const vectors = await embed(batch.map(embedTextOf))
      index = applyEmbeddings(
        index,
        batch.map((n, j) => ({ id: n.front.id, digest: embedDigestOf(n), vector: vectors[j]! })),
        liveIds,
      )
    }
    await saveVectorIndex(paths, index)
  }
  const queryCache = new Map<string, Float32Array>()
  return {
    index,
    embedQuery: async (q: string) => {
      const hit = queryCache.get(q)
      if (hit) return hit
      const [vec] = await embed([q])
      queryCache.set(q, vec!)
      return vec!
    },
  }
}

function fullMode(notes: Note[], lex: SearchHit[], sem: { id: string; score: number }[]): Scored {
  const byId = new Map(notes.map((n) => [n.front.id, n]))
  // ipc.ts buildRetrievedContext: merge(cap 12) → activation rerank → top 8.
  const hits = activationRerank(hybridMerge(lex, sem, RETRIEVE + 4), (id) => byId.get(id) ?? null, NOW)
  const ranked = hits.map((h) => h.id).slice(0, RETRIEVE)
  // linkNeighbours: spread from the hit set over links, excluding the hits.
  const exclude = new Set(hits.map((h) => h.id))
  const seeds = new Map(hits.map((h) => [h.id, h.score]))
  const neighbours = spreadActivation(seeds, notes, NOW, { limit: NEIGHBORS + exclude.size })
    .filter((a) => !exclude.has(a.id))
    .slice(0, NEIGHBORS)
    .map((a) => a.id)
  return { ranked, context: [...ranked, ...neighbours] }
}

interface QueryResult {
  query: GoldenQuery
  mode: Mode
  rankOfFirst: number // 1-based rank of first expected id, Infinity if absent
  hitAt5: boolean
  hitAt8: boolean
  inContext: number // how many expected ids the assembled context holds
  pass: boolean // category-aware verdict (synthesis/2hop use needInTop8)
}

function score(query: GoldenQuery, mode: Mode, scored: Scored): QueryResult {
  const expected = new Set(query.expected)
  let rankOfFirst = Infinity
  scored.ranked.forEach((id, i) => {
    if (expected.has(id) && i + 1 < rankOfFirst) rankOfFirst = i + 1
  })
  const inContext = scored.context.filter((id) => expected.has(id)).length
  const need = query.needInTop8 ?? 1
  return {
    query,
    mode,
    rankOfFirst,
    hitAt5: rankOfFirst <= 5,
    hitAt8: rankOfFirst <= 8,
    inContext,
    pass: inContext >= need,
  }
}

async function main(): Promise<void> {
  const notes = await buildVault()
  process.stderr.write(`vault: ${notes.length} notes, ${GOLDEN_QUERIES.length} queries\n`)
  const lexIndex = buildIndex(notes)
  const { index, embedQuery } = await ensureEmbeddings(notes)
  const diag = process.env['DIAG'] // substring of a query to dump channels for
  const results: QueryResult[] = []
  for (const query of GOLDEN_QUERIES) {
    const lex = searchIndex(lexIndex, query.q)
    const qv = await embedQuery(query.q)
    const semRaw = cosineTopK(index, qv, RETRIEVE)
    const sem = semRaw.filter((s) => s.score >= SEMANTIC_MIN_SCORE)
    if (diag && query.q.includes(diag)) {
      console.log(`\nDIAG "${query.q}" expected=${query.expected.join(',')}`)
      console.log('  lexical:', lex.slice(0, 10).map((h) => `${h.id}:${h.score.toFixed(2)}`).join(' '))
      console.log('  semantic(raw):', semRaw.map((h) => `${h.id}:${h.score.toFixed(3)}`).join(' '))
      console.log('  hybrid:', hybridMerge(lex, sem, RETRIEVE + 4).map((h) => `${h.id}:${h.score.toFixed(4)}`).join(' '))
    }
    for (const mode of MODES) {
      let scored: Scored
      if (mode === 'lexical') {
        const ranked = lex.map((h) => h.id).slice(0, RETRIEVE)
        scored = { ranked, context: ranked }
      } else if (mode === 'semantic') {
        const ranked = sem.map((h) => h.id).slice(0, RETRIEVE)
        scored = { ranked, context: ranked }
      } else if (mode === 'hybrid') {
        const ranked = hybridMerge(lex, sem, RETRIEVE + 4)
          .map((h) => h.id)
          .slice(0, RETRIEVE)
        scored = { ranked, context: ranked }
      } else {
        scored = fullMode(notes, lex, sem)
      }
      results.push(score(query, mode, scored))
    }
  }

  // ── report ──
  const categories = [...new Set(GOLDEN_QUERIES.map((q) => q.category))]
  const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(2) : '0.00')
  console.log('\n=== per mode (all queries) ===')
  console.log('mode      hit@5  hit@8  MRR    pass')
  for (const mode of MODES) {
    const rs = results.filter((r) => r.mode === mode)
    const mrr = rs.reduce((s, r) => s + (Number.isFinite(r.rankOfFirst) ? 1 / r.rankOfFirst : 0), 0) / rs.length
    console.log(
      `${mode.padEnd(9)} ${fmt(rs.filter((r) => r.hitAt5).length / rs.length).padEnd(6)} ${fmt(
        rs.filter((r) => r.hitAt8).length / rs.length,
      ).padEnd(6)} ${fmt(mrr).padEnd(6)} ${rs.filter((r) => r.pass).length}/${rs.length}`,
    )
  }
  console.log('\n=== per category (mode=full, the chat path) ===')
  console.log('category      pass   hit@8  queries')
  for (const cat of categories) {
    const rs = results.filter((r) => r.mode === 'full' && r.query.category === cat)
    console.log(
      `${cat.padEnd(13)} ${`${rs.filter((r) => r.pass).length}/${rs.length}`.padEnd(6)} ${fmt(
        rs.filter((r) => r.hitAt8).length / rs.length,
      ).padEnd(6)} ${rs.length}`,
    )
  }
  console.log('\n=== failures (mode=full) ===')
  const failures = results.filter((r) => r.mode === 'full' && !r.pass)
  if (failures.length === 0) console.log('(none)')
  for (const f of failures) {
    console.log(`[${f.query.category}] "${f.query.q}"`)
    console.log(`  expected ${f.query.expected.join(', ')} — in context ${f.inContext}/${f.query.needInTop8 ?? 1}, first rank ${Number.isFinite(f.rankOfFirst) ? f.rankOfFirst : '—'}`)
  }
  // Machine-readable line for loop automation.
  const full = results.filter((r) => r.mode === 'full')
  console.log(
    `\nSCORE full pass=${full.filter((r) => r.pass).length}/${full.length} hit@8=${fmt(full.filter((r) => r.hitAt8).length / full.length)}`,
  )
}

void main().catch((err) => {
  console.error(err)
  process.exit(1)
})
