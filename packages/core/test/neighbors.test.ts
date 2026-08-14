import { describe, expect, it } from 'vitest'
import { emptyNeighborRows, pruneNeighborRows, semanticEdges, updateNeighborRows } from '../src/neighbors.js'
import type { VectorIndex } from '../src/vectors.js'

// Synthetic 2D meaning space: angles close together = neighbours. Rows are
// unit vectors, matching applyEmbeddings' guarantee.

function indexOf(entries: { id: string; angle: number }[]): VectorIndex {
  const vectors = new Float32Array(entries.length * 2)
  entries.forEach((e, i) => {
    vectors[i * 2] = Math.cos(e.angle)
    vectors[i * 2 + 1] = Math.sin(e.angle)
  })
  return { model: 'test', dim: 2, ids: entries.map((e) => e.id), digests: entries.map(() => 'x'), vectors }
}

describe('neighbor rows — the similarity fabric cache', () => {
  it('updating a fresh note also teaches its neighbours about it (reverse insert)', () => {
    const index = indexOf([
      { id: 'old', angle: 0 },
      { id: 'fresh', angle: 0.1 }, // cos ≈ 0.995 — clearly the same neighbourhood
      { id: 'far', angle: 2.5 }, // cos < 0 — different world
    ])
    const rows = updateNeighborRows(emptyNeighborRows('test'), index, ['fresh'])
    expect(rows.rows['fresh']!.map((h) => h.id)).toEqual(['old'])
    expect(rows.rows['old']!.map((h) => h.id)).toEqual(['fresh'])
    expect(rows.rows['far']).toBeUndefined()
  })

  it('prune drops dead notes from rows and from hit lists', () => {
    const index = indexOf([
      { id: 'a', angle: 0 },
      { id: 'b', angle: 0.1 },
    ])
    const rows = updateNeighborRows(emptyNeighborRows('test'), index, ['a', 'b'])
    pruneNeighborRows(rows, new Set(['a']))
    expect(rows.rows['b']).toBeUndefined()
    expect(rows.rows['a']).toEqual([])
  })

  it('semanticEdges emits each close pair once, weighted, floor-guarded', () => {
    const index = indexOf([
      { id: 'a', angle: 0 },
      { id: 'b', angle: 0.15 }, // cos ≈ 0.989 — a strong pair
      { id: 'c', angle: 0.9 }, // cos(0.9) ≈ 0.62 vs a — below a strict floor
    ])
    const rows = updateNeighborRows(emptyNeighborRows('test'), index, ['a', 'b', 'c'])
    const strict = semanticEdges(rows, 0.95)
    expect(strict).toHaveLength(1)
    expect(strict[0]).toMatchObject({ a: 'a', b: 'b' })
    expect(strict[0]!.w).toBeGreaterThan(0.9)
    const loose = semanticEdges(rows, 0.55)
    expect(loose.length).toBeGreaterThan(1)
  })
})
