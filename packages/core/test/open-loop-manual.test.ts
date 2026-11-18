import { describe, expect, it } from 'vitest'
import { openLoops } from '../src/loops.js'
import { createNote, loadNotes, readNote, writeNote } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-27T00:00:00Z')

describe('marking a note open by hand', () => {
  it('puts an unflagged note into the open loops, and takes it back out', async () => {
    const paths = await initVault(await tmpVaultRoot('open-loop-manual'), { git: false })
    await createNote(paths, { id: 'n-backlog', body: '# Sample 포팅 작업 백로그\n\n우선순위순.' }, NOW)

    expect(openLoops(await loadNotes(paths), NOW)).toHaveLength(0)

    const note = await readNote(paths, 'n-backlog')
    note.front.open_loop = true
    await writeNote(paths, note)
    const marked = openLoops(await loadNotes(paths), NOW)
    expect(marked.map((n) => n.front.id)).toEqual(['n-backlog'])

    const done = await readNote(paths, 'n-backlog')
    done.front.open_loop = undefined
    await writeNote(paths, done)
    expect(openLoops(await loadNotes(paths), NOW)).toHaveLength(0)
    const raw = await readNote(paths, 'n-backlog')
    expect(raw.front.open_loop).toBeUndefined()
  })
})
