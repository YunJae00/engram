import { describe, expect, it } from 'vitest'
import {
  applyEmbeddings,
  cosineTopK,
  embedDigestOf,
  emptyVectorIndex,
  hybridMerge,
  loadVectorIndex,
  saveVectorIndex,
  staleForEmbedding,
} from '../src/vectors.js'
import type { Note } from '../src/schema.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// The semantic index is model-agnostic pure math — exercised end to end with
// tiny synthetic vectors (dim 3), no model anywhere near the tests.

function note(id: string, body: string): Note {
  return {
    front: {
      id,
      type: 'note',
      status: 'current',
      supersedes: [],
      derived_from: [],
      decay: 'slow',
      timeline: 'inferred',
      created: '2026-07-01T00:00:00Z',
      updated: '2026-07-01T00:00:00Z',
    },
    body,
  }
}

const vec = (...xs: number[]) => new Float32Array(xs)

describe('vector index', () => {
  it('round-trips through disk and voids itself on model switch', async () => {
    const paths = await initVault(await tmpVaultRoot('vectors'), { git: false })
    const a = note('a', '# 청킹 전략')
    let index = emptyVectorIndex('test-model', 3)
    index = applyEmbeddings(index, [{ id: 'a', digest: embedDigestOf(a), vector: vec(1, 0, 0) }], new Set(['a']))
    await saveVectorIndex(paths, index)
    const back = await loadVectorIndex(paths, 'test-model')
    expect(back?.ids).toEqual(['a'])
    expect([...back!.vectors]).toEqual([1, 0, 0])
    // A different model id must NOT reuse these vectors.
    expect(await loadVectorIndex(paths, 'other-model')).toBeNull()
  })

  it('staleForEmbedding: new and edited notes need work, unchanged ones do not', () => {
    const a = note('a', '# 청킹 전략\n\n512 토큰.')
    const b = note('b', '# 백업 정책')
    let index = emptyVectorIndex('m', 3)
    index = applyEmbeddings(index, [{ id: 'a', digest: embedDigestOf(a), vector: vec(1, 0, 0) }], new Set(['a', 'b']))
    expect(staleForEmbedding([a, b], index).map((n) => n.front.id)).toEqual(['b'])
    const aEdited = note('a', '# 청킹 전략\n\n1024 토큰으로 변경.')
    expect(staleForEmbedding([aEdited, b], index).map((n) => n.front.id)).toEqual(['a', 'b'])
  })

  it('applyEmbeddings drops rows for dead notes', () => {
    let index = emptyVectorIndex('m', 3)
    index = applyEmbeddings(
      index,
      [
        { id: 'a', digest: 'd1', vector: vec(1, 0, 0) },
        { id: 'b', digest: 'd2', vector: vec(0, 1, 0) },
      ],
      new Set(['a', 'b']),
    )
    index = applyEmbeddings(index, [], new Set(['b']))
    expect(index.ids).toEqual(['b'])
    expect([...index.vectors]).toEqual([0, 1, 0])
  })

  it('cosineTopK ranks by similarity', () => {
    let index = emptyVectorIndex('m', 3)
    index = applyEmbeddings(
      index,
      [
        { id: 'close', digest: 'd', vector: vec(0.9, 0.1, 0) },
        { id: 'far', digest: 'd', vector: vec(0, 0, 1) },
        { id: 'mid', digest: 'd', vector: vec(0.5, 0.5, 0) },
      ],
      new Set(['close', 'far', 'mid']),
    )
    const hits = cosineTopK(index, vec(1, 0, 0), 2)
    expect(hits.map((h) => h.id)).toEqual(['close', 'mid'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })
})

describe('hybridMerge (RRF)', () => {
  const lex = (id: string, rank: number) => ({ id, title: id, status: 'current', score: 100 - rank })

  it('a note found by BOTH channels beats either single-channel hit', () => {
    const merged = hybridMerge(
      [lex('both', 0), lex('lex-only', 1)],
      [
        { id: 'sem-only', score: 0.8 },
        { id: 'both', score: 0.7 },
      ],
      10,
    )
    expect(merged[0]!.id).toBe('both')
    expect(merged.map((h) => h.id)).toContain('sem-only')
  })

  it('semantic noise below the cosine floor never enters', () => {
    const merged = hybridMerge([lex('a', 0)], [{ id: 'noise', score: 0.1 }], 10)
    expect(merged.map((h) => h.id)).toEqual(['a'])
  })

  it('pure-semantic hits surface even with zero lexical overlap', () => {
    const merged = hybridMerge([], [{ id: 'meaning', score: 0.6 }], 10)
    expect(merged.map((h) => h.id)).toEqual(['meaning'])
  })

  // The golden-set regression (scripts/eval-retrieval.mts): CJK bigram
  // overlap puts junk at lexical rank 1 while the true answer sits at
  // semantic rank 1 with a strong cosine. Rank-only fusion buried it.
  it('a strong semantic rank-1 outvotes a junk lexical rank-1 the semantic channel never saw', () => {
    const merged = hybridMerge(
      [lex('bigram-junk', 0), lex('other-junk', 1)],
      [{ id: 'true-answer', score: 0.68 }],
      10,
    )
    expect(merged[0]!.id).toBe('true-answer')
  })

  it('a barely-above-floor semantic hit stays below a lexical rank-1', () => {
    const merged = hybridMerge([lex('exact-term', 0)], [{ id: 'weak-hint', score: 0.36 }], 10)
    expect(merged[0]!.id).toBe('exact-term')
  })
})
