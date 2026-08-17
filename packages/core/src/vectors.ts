import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Note } from './schema.js'
import { noteTitle } from './schema.js'
import type { SearchHit } from './search.js'
import type { VaultPaths } from './vault.js'

const META_FILE = 'vectors.json'
const BIN_FILE = 'vectors.bin'

// What gets embedded per note: the title plus the head of the body — notes
// are short and front-loaded, and a fixed slice keeps embed cost flat.
export const EMBED_CHARS = 800

export function embedTextOf(note: Note): string {
  return `${noteTitle(note)}\n${note.body.slice(0, EMBED_CHARS)}`
}

export function embedDigestOf(note: Note): string {
  return createHash('sha1').update(embedTextOf(note)).digest('hex').slice(0, 12)
}

interface VectorMeta {
  model: string
  dim: number
  ids: string[]
  digests: string[]
}

export interface VectorIndex {
  model: string
  dim: number
  ids: string[]
  digests: string[]
  // Row-major Float32: vectors[i] starts at i*dim.
  vectors: Float32Array
}

export function emptyVectorIndex(model: string, dim: number): VectorIndex {
  return { model, dim, ids: [], digests: [], vectors: new Float32Array(0) }
}

export async function loadVectorIndex(paths: VaultPaths, model: string): Promise<VectorIndex | null> {
  try {
    const meta = JSON.parse(await readFile(join(paths.cache, META_FILE), 'utf8')) as VectorMeta
    if (meta.model !== model) return null // model switched — the index is void
    const raw = await readFile(join(paths.cache, BIN_FILE))
    const vectors = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4)
    if (vectors.length !== meta.ids.length * meta.dim) return null // torn write
    return { ...meta, vectors }
  } catch {
    return null
  }
}

export async function saveVectorIndex(paths: VaultPaths, index: VectorIndex): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  const meta: VectorMeta = { model: index.model, dim: index.dim, ids: index.ids, digests: index.digests }
  await writeFile(join(paths.cache, BIN_FILE), Buffer.from(index.vectors.buffer, index.vectors.byteOffset, index.vectors.byteLength))
  await writeFile(join(paths.cache, META_FILE), JSON.stringify(meta))
}

// Notes whose embedding is missing or whose content changed since it was
// made — the incremental work list for the background indexer.
export function staleForEmbedding(notes: Note[], index: VectorIndex): Note[] {
  const have = new Map(index.ids.map((id, i) => [id, index.digests[i]!]))
  return notes.filter((n) => have.get(n.front.id) !== embedDigestOf(n))
}

// Unit-normalize in place-ish (returns a copy when scaling is needed) so the
// query scan can be a pure dot product — cosine without per-row norms.
function normalized(vector: Float32Array): Float32Array {
  let norm = 0
  for (let i = 0; i < vector.length; i++) norm += vector[i]! * vector[i]!
  norm = Math.sqrt(norm)
  if (norm === 0 || Math.abs(norm - 1) < 1e-6) return vector
  const out = new Float32Array(vector.length)
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm
  return out
}

// Fold freshly-embedded rows in (replacing stale rows) and drop rows whose
// notes no longer exist. Rows are stored UNIT-NORMALIZED (models emit unit
// vectors already; this is the defensive guarantee the dot-product scan
// relies on). Returns a NEW index.
export function applyEmbeddings(
  index: VectorIndex,
  updates: { id: string; digest: string; vector: Float32Array }[],
  liveIds: Set<string>,
): VectorIndex {
  const dim = index.dim
  const rows = new Map<string, { digest: string; vector: Float32Array }>()
  index.ids.forEach((id, i) => {
    if (liveIds.has(id)) rows.set(id, { digest: index.digests[i]!, vector: index.vectors.subarray(i * dim, (i + 1) * dim) })
  })
  for (const u of updates) {
    if (u.vector.length !== dim) continue
    if (liveIds.has(u.id)) rows.set(u.id, { digest: u.digest, vector: normalized(u.vector) })
  }
  const ids = [...rows.keys()]
  const digests = ids.map((id) => rows.get(id)!.digest)
  const vectors = new Float32Array(ids.length * dim)
  ids.forEach((id, i) => vectors.set(rows.get(id)!.vector, i * dim))
  return { model: index.model, dim, ids, digests, vectors }
}

export interface SemanticHit {
  id: string
  score: number // cosine similarity
}

export function cosineTopK(index: VectorIndex, query: Float32Array, k: number): SemanticHit[] {
  if (query.length !== index.dim || index.ids.length === 0) return []
  const q = normalized(query)
  const hits: SemanticHit[] = []
  const dim = index.dim
  for (let row = 0; row < index.ids.length; row++) {
    let dot = 0
    const base = row * dim
    for (let i = 0; i < dim; i++) dot += index.vectors[base + i]! * q[i]!
    hits.push({ id: index.ids[row]!, score: dot })
  }
  return hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, k)
}

// Reciprocal-rank fusion: lexical and cosine scores live on incompatible
// scales, so ranks are fused — but the semantic vote scales with the cosine.
// A rank is only "first among what this channel saw": CJK bigram overlap can
// put a junk note at lexical rank 1 while the true answer sits at semantic
// rank 1 with a strong cosine, and pure rank fusion buries it. So
// near-paraphrase evidence (≥ SEMANTIC_STRONG) outvotes any single lexical
// rank, a barely-above-floor match stays a hint below lexical, and a note
// found by BOTH channels still rises above either alone. Calibrated against
// scripts/eval-retrieval.mts (apps/desktop).
const RRF_K = 60
const LEXICAL_WEIGHT = 1.0
const SEMANTIC_WEIGHT_MIN = 0.6
const SEMANTIC_WEIGHT_MAX = 1.5
// Above this cosine a hit reads as "same subject, other words" for bge-m3.
const SEMANTIC_STRONG = 0.65
// Cosine floor: below this the "match" is noise, not meaning.
export const SEMANTIC_MIN_SCORE = 0.35

function semanticWeight(score: number): number {
  const t = Math.min(1, Math.max(0, (score - SEMANTIC_MIN_SCORE) / (SEMANTIC_STRONG - SEMANTIC_MIN_SCORE)))
  return SEMANTIC_WEIGHT_MIN + (SEMANTIC_WEIGHT_MAX - SEMANTIC_WEIGHT_MIN) * t
}

export function hybridMerge(lexical: SearchHit[], semantic: SemanticHit[], cap: number): SearchHit[] {
  const fused = new Map<string, { score: number; hit: SearchHit }>()
  lexical.forEach((hit, rank) => {
    fused.set(hit.id, { score: LEXICAL_WEIGHT / (RRF_K + rank + 1), hit })
  })
  semantic
    .filter((s) => s.score >= SEMANTIC_MIN_SCORE)
    .forEach((s, rank) => {
      const add = semanticWeight(s.score) / (RRF_K + rank + 1)
      const prior = fused.get(s.id)
      if (prior) prior.score += add
      else fused.set(s.id, { score: add, hit: { id: s.id, title: '', status: '', score: 0 } })
    })
  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([id, { score, hit }]) => ({ ...hit, id, score }))
}
