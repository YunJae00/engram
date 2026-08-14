import { rm, writeFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it } from 'vitest'
import { createNote, notePath } from '../src/notes.js'
import { serializeNote, type Note } from '../src/schema.js'
import { NoteStore } from '../src/store.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-01T00:00:00Z')
let paths: VaultPaths

beforeEach(async () => {
  paths = await initVault(await tmpVaultRoot('store'), { git: false })
})

describe('NoteStore.open', () => {
  it('returns every note in id order regardless of write order', async () => {
    await createNote(paths, { id: 'c-note', body: '# Gamma' }, NOW)
    await createNote(paths, { id: 'a-note', body: '# Alpha' }, NOW)
    await createNote(paths, { id: 'b-note', body: '# Beta' }, NOW)
    const store = await NoteStore.open(paths)
    expect(store.getAll().map((n) => n.front.id)).toEqual(['a-note', 'b-note', 'c-note'])
    expect(store.get('b-note')?.body).toContain('Beta')
    expect(store.get('missing')).toBeNull()
  })
})

describe('NoteStore.applyFile', () => {
  it('add surfaces the note as an upsert and in search', async () => {
    const store = await NoteStore.open(paths)
    await createNote(paths, { id: 'x1', body: '# Deploy pipeline\n\nCI pipeline steps.' }, NOW)
    const delta = await store.applyFile('add', notePath(paths, 'x1'))
    expect(delta.removed).toEqual([])
    expect(delta.upserts.map((n) => n.front.id)).toEqual(['x1'])
    expect(store.getAll()).toHaveLength(1)
    expect(store.search('pipeline').map((h) => h.id)).toEqual(['x1'])
  })

  it('change replaces the note and re-indexes its body', async () => {
    await createNote(paths, { id: 'x1', body: '# Deploy pipeline\n\nCI pipeline steps.' }, NOW)
    const store = await NoteStore.open(paths)
    const changed: Note = {
      front: { ...store.get('x1')!.front, updated: NOW.toISOString() },
      body: '# Rollback plan\n\nHow to rollback safely.',
    }
    await writeFile(notePath(paths, 'x1'), serializeNote(changed))
    const delta = await store.applyFile('change', notePath(paths, 'x1'))
    expect(delta.upserts[0]?.body).toContain('Rollback')
    expect(store.get('x1')?.body).toContain('Rollback')
    expect(store.search('rollback').map((h) => h.id)).toEqual(['x1'])
    expect(store.search('pipeline')).toEqual([])
  })

  it('unlink drops the note from getAll, get and search', async () => {
    await createNote(paths, { id: 'x1', body: '# Rollback plan' }, NOW)
    const store = await NoteStore.open(paths)
    await rm(notePath(paths, 'x1'))
    const delta = await store.applyFile('unlink', notePath(paths, 'x1'))
    expect(delta.upserts).toEqual([])
    expect(delta.removed).toEqual(['x1'])
    expect(store.get('x1')).toBeNull()
    expect(store.getAll()).toEqual([])
    expect(store.search('rollback')).toEqual([])
  })

  it('unlink of an unknown file is an empty delta', async () => {
    const store = await NoteStore.open(paths)
    expect(await store.applyFile('unlink', notePath(paths, 'ghost'))).toEqual({
      upserts: [],
      removed: [],
    })
  })

  it('a parse failure keeps the previous note and returns an empty delta', async () => {
    await createNote(paths, { id: 'x2', body: '# Keep me\n\noriginal body' }, NOW)
    const store = await NoteStore.open(paths)
    // Frontmatter missing required id/created/updated → zod rejects it.
    await writeFile(notePath(paths, 'x2'), '---\nfoo: bar\n---\n# Garbage\n')
    const delta = await store.applyFile('change', notePath(paths, 'x2'))
    expect(delta).toEqual({ upserts: [], removed: [] })
    expect(store.get('x2')?.body).toContain('original body')
    expect(store.search('keep').map((h) => h.id)).toEqual(['x2'])
  })

  it('ignores paths that are not .md files directly inside notes/', async () => {
    const store = await NoteStore.open(paths)
    const empty = { upserts: [], removed: [] }
    // Wrong directory (inbox), wrong extension, and a nested subfolder.
    expect(await store.applyFile('add', notePath({ ...paths, notes: paths.inbox }, 'a'))).toEqual(empty)
    expect(await store.applyFile('add', `${paths.notes}/note.txt`)).toEqual(empty)
    expect(await store.applyFile('add', `${paths.notes}/sub/note.md`)).toEqual(empty)
    expect(store.getAll()).toEqual([])
  })
})
