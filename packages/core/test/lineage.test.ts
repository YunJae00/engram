import { describe, expect, it } from 'vitest'
import { ancestorsOf, buildLineage, chainOf, descendantsOf, detectInversions } from '../src/lineage.js'
import type { Note } from '../src/schema.js'
import { frontmatterSchema } from '../src/schema.js'

function makeNote(id: string, over: Record<string, unknown> = {}): Note {
  return {
    front: frontmatterSchema.parse({
      id,
      created: '2026-06-01T00:00:00Z',
      updated: '2026-06-01T00:00:00Z',
      ...over,
    }),
    body: `# ${id}`,
  }
}

const v1 = makeNote('n-v-0001', { status: 'superseded', created: '2026-01-01T00:00:00Z' })
const v2 = makeNote('n-v-0002', {
  status: 'superseded',
  supersedes: ['n-v-0001'],
  created: '2026-02-01T00:00:00Z',
})
const v3 = makeNote('n-v-0003', {
  status: 'current',
  supersedes: ['n-v-0002'],
  created: '2026-03-01T00:00:00Z',
})

describe('lineage graph', () => {
  it('resolves transitive ancestors', () => {
    const graph = buildLineage([v1, v2, v3])
    expect(ancestorsOf(graph, 'n-v-0003').map((n) => n.front.id)).toEqual(['n-v-0002', 'n-v-0001'])
  })

  it('resolves transitive descendants', () => {
    const graph = buildLineage([v1, v2, v3])
    expect(descendantsOf(graph, 'n-v-0001').map((n) => n.front.id)).toEqual(['n-v-0002', 'n-v-0003'])
  })

  it('chainOf returns the full chain oldest → newest from any member', () => {
    const graph = buildLineage([v1, v2, v3])
    expect(chainOf(graph, 'n-v-0002').map((n) => n.front.id)).toEqual([
      'n-v-0001',
      'n-v-0002',
      'n-v-0003',
    ])
  })

  it('detects supersede/chronology inversions', () => {
    const older = makeNote('n-o-0001', { happened_at: '2026-05-01' })
    const newer = makeNote('n-n-0001', { supersedes: ['n-o-0001'], happened_at: '2026-04-01' })
    expect(detectInversions([older, newer])).toEqual([{ newerId: 'n-n-0001', olderId: 'n-o-0001' }])
  })

  it('reports no inversion for consistent or undated chains', () => {
    const older = makeNote('n-o-0002', { happened_at: '2026-03-01' })
    const newer = makeNote('n-n-0002', { supersedes: ['n-o-0002'], happened_at: '2026-04-01' })
    const undated = makeNote('n-u-0002', { supersedes: ['n-o-0002'] })
    expect(detectInversions([older, newer, undated])).toEqual([])
  })
})
