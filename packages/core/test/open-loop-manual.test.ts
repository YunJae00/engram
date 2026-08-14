import { describe, expect, it } from 'vitest'
import { openLoops } from '../src/loops.js'
import { createNote, loadNotes, readNote, writeNote } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const NOW = new Date('2026-07-27T00:00:00Z')

// The librarian judges open_loop from the capture text alone, so it misses
// things — and a note written before the field existed was never judged at
// all. Marking one by hand is the only route those notes have into Today, so
// the round trip is worth pinning: flag on disk → openLoops() → flag off again.
describe('marking a note open by hand', () => {
  it('puts an unflagged note into the open loops, and takes it back out', async () => {
    const paths = await initVault(await tmpVaultRoot('open-loop-manual'), { git: false })
    await createNote(paths, { id: 'n-backlog', body: '# ChatX 포팅 작업 백로그\n\n우선순위순.' }, NOW)

    expect(openLoops(await loadNotes(paths), NOW)).toHaveLength(0)

    const note = await readNote(paths, 'n-backlog')
    note.front.open_loop = true
    await writeNote(paths, note)
    const marked = openLoops(await loadNotes(paths), NOW)
    expect(marked.map((n) => n.front.id)).toEqual(['n-backlog'])

    // Clearing it must REMOVE the key, not write `open_loop: false` — the
    // schema reads absent as "not a loop", so a false would be dead weight on
    // every note anyone ever ticked and unticked.
    const done = await readNote(paths, 'n-backlog')
    done.front.open_loop = undefined
    await writeNote(paths, done)
    expect(openLoops(await loadNotes(paths), NOW)).toHaveLength(0)
    const raw = await readNote(paths, 'n-backlog')
    expect(raw.front.open_loop).toBeUndefined()
  })
})
