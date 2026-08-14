import { describe, expect, it } from 'vitest'
import { buildJ2 } from '../src/jobs/librarian.js'
import { createNote, readNote } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-10T00:00:00Z')

describe('J2 link enrichment stores per-link reasons', () => {
  async function fixture(prefix: string) {
    const paths = await initVault(await tmpVaultRoot(prefix), { git: false })
    const a = await createNote(paths, { id: 'n-target-0001', body: '# 배포 절차\n\n금요일 배포로 변경.' }, NOW)
    const b = await createNote(paths, { id: 'n-rel-0001', body: '# 배포 요일 결정\n\n화요일에서 금요일로.' }, NOW)
    const c = await createNote(paths, { id: 'n-rel-0002', body: '# CI 파이프라인\n\n배포 전 테스트.' }, NOW)
    return { paths, target: a, corpus: [a, b, c] }
  }

  it('writes derived_from + link_reasons from the {id,reason} shape', async () => {
    const { paths, target, corpus } = await fixture('j2-reasons')
    const spec = buildJ2(paths, '', target, corpus, NOW)
    const effects = await spec.apply(
      JSON.stringify({
        links: [
          { id: 'n-rel-0001', reason: '같은 배포 요일 변경을 다룬다' },
          { id: 'n-rel-0002', reason: '배포 절차의 선행 단계' },
          { id: 'n-ghost-0001', reason: '존재하지 않는 후보' },
        ],
      }),
    )
    expect(effects.join('\n')).toContain('n-rel-0001')
    const note = await readNote(paths, 'n-target-0001')
    expect(note.front.derived_from).toEqual(['n-rel-0001', 'n-rel-0002'])
    expect(note.front.link_reasons).toEqual({
      'n-rel-0001': '같은 배포 요일 변경을 다룬다',
      'n-rel-0002': '배포 절차의 선행 단계',
    })
  })

  it('still accepts the legacy bare-id array (no reasons written)', async () => {
    const { paths, target, corpus } = await fixture('j2-legacy')
    const spec = buildJ2(paths, '', target, corpus, NOW)
    await spec.apply(JSON.stringify({ links: ['n-rel-0001'] }))
    const note = await readNote(paths, 'n-target-0001')
    expect(note.front.derived_from).toEqual(['n-rel-0001'])
    expect(note.front.link_reasons).toBeUndefined()
  })

  it('link_reasons round-trips through note serialization', async () => {
    const { paths, target, corpus } = await fixture('j2-roundtrip')
    const spec = buildJ2(paths, '', target, corpus, NOW)
    await spec.apply(JSON.stringify({ links: [{ id: 'n-rel-0001', reason: '근거 노트' }] }))
    // A second read from disk goes through parseNote — the reason must survive.
    const reread = await readNote(paths, 'n-target-0001')
    expect(reread.front.link_reasons?.['n-rel-0001']).toBe('근거 노트')
  })

  it('asks the engine for a reason per link and offers hub-free candidates', () => {
    const { prompt } = buildJ2({} as never, '', makeTarget(), [makeTarget(), hubNote()], NOW)
    expect(prompt).toContain('"reason"')
    expect(prompt).not.toContain('n-hub-0001')
  })
})

function makeTarget() {
  return {
    front: {
      id: 'n-solo-0001', type: 'note', status: 'current' as const, supersedes: [], derived_from: [],
      decay: 'slow' as const, timeline: 'inferred' as const,
      created: NOW.toISOString(), updated: NOW.toISOString(),
    },
    body: '# 혼자\n\n내용',
  }
}

function hubNote() {
  return {
    front: {
      id: 'n-hub-0001', type: 'hub', status: 'current' as const, supersedes: [], derived_from: [],
      decay: 'slow' as const, timeline: 'inferred' as const,
      created: NOW.toISOString(), updated: NOW.toISOString(),
    },
    body: '# 허브\n\n종합',
  }
}
