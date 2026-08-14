import { describe, expect, it } from 'vitest'
import { undeterminedNotes } from '../src/chronology.js'
import { freshnessOf } from '../src/freshness.js'
import { buildLineage, chainOf } from '../src/lineage.js'
import { loadNotes } from '../src/notes.js'
import { generateSampleVault } from '../src/sample-vault.js'
import { tmpVaultRoot } from './helpers.js'

describe('sample vault generator', () => {
  it('seeds chain, dispute pair, expired and undetermined notes', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('sample'))
    const notes = await loadNotes(paths)
    expect(notes.length).toBeGreaterThanOrEqual(9)

    const graph = buildLineage(notes)
    expect(chainOf(graph, 'n-deploy-0001').map((n) => n.front.id)).toEqual([
      'n-deploy-0001',
      'n-deploy-0002',
      'n-deploy-0003',
    ])
    const byId = new Map(notes.map((n) => [n.front.id, n]))
    expect(byId.get('n-price-0001')!.front.status).toBe('disputed')
    expect(freshnessOf(byId.get('n-sprint-0001')!, new Date('2026-07-01T00:00:00Z'))).toBe('stale')
    expect(undeterminedNotes(notes).map((n) => n.front.id)).toContain('n-idea-0001')
  })
})
