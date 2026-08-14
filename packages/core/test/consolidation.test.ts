import { beforeEach, describe, expect, it } from 'vitest'
import { linkComponents, planHubJobs } from '../src/jobs/hub.js'
import { createNote } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-08-13T00:00:00Z')
let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('consolidation'), { git: false })
})

async function fourLooseNotes() {
  const ids: string[] = []
  for (let i = 0; i < 4; i++) {
    const note = await createNote(paths, { id: `n-k8s-000${i}`, body: `# 쿠버네티스 메모 ${i}\n\n배포 관련 결정 ${i}.` }, NOW)
    ids.push(note.front.id)
  }
  return ids
}

describe('fabric clusters feed hub synthesis', () => {
  it('a meaning-only cluster of 4 becomes one topic', async () => {
    const ids = await fourLooseNotes()
    const { loadNotes } = await import('../src/notes.js')
    const notes = await loadNotes(paths)
    const chain = ids.slice(1).map((id, i) => ({ a: ids[i]!, b: id, w: 0.8 }))
    expect(linkComponents(notes, {}, chain)).toHaveLength(1)
    expect(linkComponents(notes, {})).toHaveLength(0) // no fabric → loose
  })

  it('planHubJobs enqueues a J9 synthesis for the fabric cluster', async () => {
    const ids = await fourLooseNotes()
    const { loadNotes } = await import('../src/notes.js')
    const notes = await loadNotes(paths)
    const chain = ids.slice(1).map((id, i) => ({ a: ids[i]!, b: id, w: 0.8 }))
    const jobs = planHubJobs(paths, 'agents', notes, NOW, 3, {}, chain)
    expect(jobs).toHaveLength(1)
    expect(jobs[0]!.kind).toBe('J9')
    expect(planHubJobs(paths, 'agents', notes, NOW, 3, {})).toHaveLength(0)
  })
})
