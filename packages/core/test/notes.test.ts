import { beforeAll, describe, expect, it } from 'vitest'
import * as notesApi from '../src/notes.js'
import {
  createNote,
  disputeNotes,
  filterByStatus,
  loadNotes,
  mergeInto,
  readNote,
  retireNote,
  supersedeNote,
  verifyNote,
} from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-01T00:00:00Z')
let paths: VaultPaths

beforeAll(async () => {
  paths = await initVault(await tmpVaultRoot('notes'), { git: false })
})

describe('note operations (append-mostly)', () => {
  it('createNote writes a schema-valid file with decay-derived verified_until', async () => {
    const note = await createNote(paths, { body: '# 노트\n\n내용', decay: 'fast' }, NOW)
    const reread = await readNote(paths, note.front.id)
    expect(reread.front.status).toBe('current')
    expect(Date.parse(reread.front.verified_until!)).toBe(NOW.getTime() + 30 * 86_400_000)
  })

  it('evergreen notes get no verified_until', async () => {
    const note = await createNote(paths, { body: '# 원리', decay: 'evergreen' }, NOW)
    expect(note.front.verified_until).toBeUndefined()
  })

  it('supersedeNote creates a replacement and flips the old note', async () => {
    const v1 = await createNote(paths, { body: '# 절차 v1' }, NOW)
    const v2 = await supersedeNote(paths, [v1.front.id], { body: '# 절차 v2' }, NOW)
    expect(v2.front.supersedes).toContain(v1.front.id)
    expect((await readNote(paths, v1.front.id)).front.status).toBe('superseded')
    expect(v2.front.status).toBe('current')
  })

  it('builds a 3-step chain with exactly one current note', async () => {
    const a = await createNote(paths, { body: '# A v1' }, NOW)
    const b = await supersedeNote(paths, [a.front.id], { body: '# A v2' }, NOW)
    const c = await supersedeNote(paths, [b.front.id], { body: '# A v3' }, NOW)
    const all = await loadNotes(paths)
    const chainNotes = all.filter((n) => [a, b, c].some((x) => x.front.id === n.front.id))
    expect(filterByStatus(chainNotes, 'current').map((n) => n.front.id)).toEqual([c.front.id])
  })

  it('disputeNotes marks both sides disputed', async () => {
    const x = await createNote(paths, { body: '# 가격 5만' }, NOW)
    const y = await createNote(paths, { body: '# 가격 7만' }, NOW)
    await disputeNotes(paths, [x.front.id, y.front.id], NOW)
    expect((await readNote(paths, x.front.id)).front.status).toBe('disputed')
    expect((await readNote(paths, y.front.id)).front.status).toBe('disputed')
  })

  it('verifyNote resets the freshness clock and clears dispute', async () => {
    const note = await createNote(paths, { body: '# 확인 대상', decay: 'fast' }, NOW)
    await disputeNotes(paths, [note.front.id], NOW)
    const later = new Date('2026-08-01T00:00:00Z')
    const verified = await verifyNote(paths, note.front.id, later)
    expect(Date.parse(verified.front.verified_until!)).toBe(later.getTime() + 30 * 86_400_000)
    expect(verified.front.status).toBe('current')
  })

  it('retireNote discards by status transition, file stays', async () => {
    const note = await createNote(paths, { body: '# 폐기 대상' }, NOW)
    await retireNote(paths, note.front.id, NOW)
    const reread = await readNote(paths, note.front.id)
    expect(reread.front.status).toBe('superseded')
  })

  it('mergeInto supersedes all sources and records derived_from', async () => {
    const s1 = await createNote(paths, { body: '# 중복 1' }, NOW)
    const s2 = await createNote(paths, { body: '# 중복 2' }, NOW)
    const merged = await mergeInto(paths, [s1.front.id, s2.front.id], '# 병합 결과', NOW)
    expect(merged.front.supersedes).toEqual(expect.arrayContaining([s1.front.id, s2.front.id]))
    expect(merged.front.derived_from).toEqual([s1.front.id, s2.front.id])
    expect((await readNote(paths, s1.front.id)).front.status).toBe('superseded')
    expect((await readNote(paths, s2.front.id)).front.status).toBe('superseded')
  })

  it('exposes no delete/remove API (append-mostly contract)', () => {
    // unlinkNotes edits frontmatter links; it never deletes a file, so the
    // contract here is strictly about delete/remove.
    const names = Object.keys(notesApi)
    expect(names.filter((n) => /delete|remove/i.test(n))).toEqual([])
  })
})
