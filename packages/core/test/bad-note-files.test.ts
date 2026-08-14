import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createNote, loadNotes, type SkippedNote } from '../src/notes.js'
import { NoteStore } from '../src/store.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const BAD: { name: string; why: string; write: (dir: string) => Promise<void> }[] = [
  {
    name: 'bad-yaml.md',
    why: 'a tab in YAML indentation',
    write: (d) => writeFile(join(d, 'bad-yaml.md'), '---\ntitle: x\n\tstatus: seed\n---\n\nbody\n'),
  },
  {
    name: 'no-close.md',
    why: 'unterminated frontmatter fence',
    write: (d) => writeFile(join(d, 'no-close.md'), '---\ntitle: x\n\nbody, no closing fence\n'),
  },
  {
    name: 'dupe.md',
    why: 'duplicate YAML key',
    write: (d) => writeFile(join(d, 'dupe.md'), '---\nstatus: seed\nstatus: grown\n---\n\nbody\n'),
  },
  {
    name: 'cp949.md',
    why: 'not valid UTF-8 (saved by a cp949 editor)',
    write: (d) => writeFile(join(d, 'cp949.md'), Buffer.from([0xed, 0x95, 0x9c, 0xb0, 0xa1, 0xb3, 0xaa, 0x0a])),
  },
  {
    name: 'empty.md',
    why: 'zero bytes — an editor died mid-save',
    write: (d) => writeFile(join(d, 'empty.md'), ''),
  },
  {
    name: 'list-front.md',
    why: 'frontmatter is a list, not a map',
    write: (d) => writeFile(join(d, 'list-front.md'), '---\n- a\n- b\n---\n\nbody\n'),
  },
  {
    name: 'folder.md',
    why: 'a DIRECTORY ending in .md — Dropbox and iCloud make these for sync conflicts',
    write: async (d) => {
      await mkdir(join(d, 'folder.md'), { recursive: true })
    },
  },
]

describe('one bad file must not cost the vault', () => {
  for (const bad of BAD) {
    it(`opens past ${bad.name} (${bad.why}) and names it`, async () => {
      const paths = await initVault(await tmpVaultRoot('badnote'), { git: false })
      for (let i = 0; i < 3; i += 1) {
        await createNote(paths, { id: `good-${i}`, body: `# Good ${i}\n\nbody` })
      }
      await bad.write(paths.notes)

      const skipped: SkippedNote[] = []
      const notes = await loadNotes(paths, (s) => skipped.push(s))

      // Every healthy note is still there…
      expect(notes.map((n) => n.front.id).sort()).toEqual(['good-0', 'good-1', 'good-2'])
      // …and the bad one is reported rather than silently missing. A note that
      // vanishes with no explanation is its own bug report.
      expect(skipped.map((s) => s.file)).toEqual([bad.name])
      expect(skipped[0]!.reason.length).toBeGreaterThan(0)
    })
  }

  it('NoteStore.open survives them all at once and carries the list', async () => {
    const paths = await initVault(await tmpVaultRoot('badnote-store'), { git: false })
    await createNote(paths, { id: 'survivor', body: '# Survivor\n\nbody' })
    for (const bad of BAD) await bad.write(paths.notes)

    const store = await NoteStore.open(paths)
    expect(store.getAll().map((n) => n.front.id)).toEqual(['survivor'])
    expect([...store.skipped].map((s) => s.file).sort()).toEqual(BAD.map((b) => b.name).sort())
  })
})
