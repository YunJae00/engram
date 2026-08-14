import { beforeAll, describe, expect, it } from 'vitest'
import { createNote, readNote, recordCoRecall, recordRecall } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

// Recall reinforcement (Engram redesign): last_recalled stamps retrieval
// WITHOUT counting as an edit — `updated` must stay untouched so the tidy
// badge / sweep delta / re-ask guard never see a recall as new work.

const NOW = new Date('2026-07-20T09:00:00Z')
let paths: VaultPaths

beforeAll(async () => {
  paths = await initVault(await tmpVaultRoot('recall'), { git: false })
})

describe('recordRecall (last_recalled)', () => {
  it('stamps last_recalled and leaves updated untouched', async () => {
    const note = await createNote(paths, { body: '# PG 결정\n\n수수료 때문에 A사로.' }, NOW)
    const at = new Date('2026-07-20T12:00:00Z')
    expect(await recordRecall(paths, note.front.id, at)).toBe(true)
    const reread = await readNote(paths, note.front.id)
    expect(reread.front.last_recalled).toBe(at.toISOString())
    expect(reread.front.updated).toBe(note.front.updated)
  })

  it('throttles: a recall within the hour is a no-op', async () => {
    const note = await createNote(paths, { body: '# 백업 정책' }, NOW)
    const first = new Date('2026-07-20T12:00:00Z')
    await recordRecall(paths, note.front.id, first)
    expect(await recordRecall(paths, note.front.id, new Date('2026-07-20T12:30:00Z'))).toBe(false)
    const reread = await readNote(paths, note.front.id)
    expect(reread.front.last_recalled).toBe(first.toISOString())
    // …and after the hour it advances again.
    const later = new Date('2026-07-20T13:30:00Z')
    expect(await recordRecall(paths, note.front.id, later)).toBe(true)
    expect((await readNote(paths, note.front.id)).front.last_recalled).toBe(later.toISOString())
  })
})

describe('recordCoRecall (Hebbian recall_links)', () => {
  it('wires co-recalled notes symmetrically without touching updated', async () => {
    const a = await createNote(paths, { body: '# 배포 정책' }, NOW)
    const b = await createNote(paths, { body: '# 롤백 절차' }, NOW)
    const at = new Date('2026-07-20T12:00:00Z')
    await recordCoRecall(paths, [a.front.id, b.front.id], at)
    const ra = await readNote(paths, a.front.id)
    const rb = await readNote(paths, b.front.id)
    expect(ra.front.recall_links?.[b.front.id]?.w).toBe(1)
    expect(rb.front.recall_links?.[a.front.id]?.w).toBe(1)
    expect(ra.front.updated).toBe(a.front.updated)

    // Within the hour the pair is throttled; after it, the weight grows.
    await recordCoRecall(paths, [a.front.id, b.front.id], new Date('2026-07-20T12:30:00Z'))
    expect((await readNote(paths, a.front.id)).front.recall_links?.[b.front.id]?.w).toBe(1)
    await recordCoRecall(paths, [a.front.id, b.front.id], new Date('2026-07-20T14:00:00Z'))
    const grown = (await readNote(paths, a.front.id)).front.recall_links?.[b.front.id]?.w ?? 0
    expect(grown).toBeGreaterThan(1.9) // ~1 (barely decayed) + 1
  })

  it('a solo recall wires nothing', async () => {
    const solo = await createNote(paths, { body: '# 단독 기억' }, NOW)
    await recordCoRecall(paths, [solo.front.id], new Date('2026-07-20T12:00:00Z'))
    expect((await readNote(paths, solo.front.id)).front.recall_links).toBeUndefined()
  })
})
