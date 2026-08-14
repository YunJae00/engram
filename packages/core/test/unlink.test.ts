import { readFile } from 'node:fs/promises'
import { beforeAll, describe, expect, it } from 'vitest'
import { createNote, notePath, readNote, unlinkNotes, writeNote } from '../src/notes.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-01T00:00:00Z')
const LATER = new Date('2026-07-10T00:00:00Z')
let paths: VaultPaths

beforeAll(async () => {
  paths = await initVault(await tmpVaultRoot('unlink'), { git: false })
})

// Build a note deriving from the given ids, with a reason per link.
async function noteWithLinks(ids: string[]): Promise<string> {
  const note = await createNote(paths, { body: '# 링크 보유', derived_from: ids }, NOW)
  note.front.link_reasons = Object.fromEntries(ids.map((id) => [id, `reason for ${id}`]))
  await writeNote(paths, note)
  return note.front.id
}

describe('unlinkNotes (pure vault surgery)', () => {
  it('removes the link and its reason, bumps updated, persists to disk', async () => {
    const target = await createNote(paths, { body: '# 근거' }, NOW)
    const id = await noteWithLinks([target.front.id])
    await unlinkNotes(paths, id, target.front.id, LATER)
    const reread = await readNote(paths, id)
    expect(reread.front.derived_from).toEqual([])
    expect(reread.front.link_reasons).toBeUndefined()
    expect(reread.front.updated).toBe(LATER.toISOString())
  })

  it('removing one of two links keeps the other link and its reason', async () => {
    const a = await createNote(paths, { body: '# 근거 A' }, NOW)
    const b = await createNote(paths, { body: '# 근거 B' }, NOW)
    const id = await noteWithLinks([a.front.id, b.front.id])
    await unlinkNotes(paths, id, a.front.id, LATER)
    const reread = await readNote(paths, id)
    expect(reread.front.derived_from).toEqual([b.front.id])
    expect(reread.front.link_reasons).toEqual({ [b.front.id]: `reason for ${b.front.id}` })
  })

  it('removing the last reasoned link leaves no link_reasons key in the file', async () => {
    const target = await createNote(paths, { body: '# 근거' }, NOW)
    const id = await noteWithLinks([target.front.id])
    await unlinkNotes(paths, id, target.front.id, LATER)
    const raw = await readFile(notePath(paths, id), 'utf8')
    expect(raw).not.toContain('link_reasons')
  })

  it('unlinking a non-existent target is a no-op (updated unchanged)', async () => {
    const target = await createNote(paths, { body: '# 근거' }, NOW)
    const id = await noteWithLinks([target.front.id])
    const before = await readNote(paths, id)
    const result = await unlinkNotes(paths, id, 'no-such-id', LATER)
    expect(result.front.updated).toBe(before.front.updated)
    const reread = await readNote(paths, id)
    expect(reread.front.derived_from).toEqual([target.front.id])
    expect(reread.front.updated).toBe(before.front.updated)
  })
})
