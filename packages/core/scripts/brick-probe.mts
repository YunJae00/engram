// Can one bad file in notes/ stop the whole vault from opening?
//
// loadNotes reads every .md through Promise.all. A rejection anywhere in a
// chunk rejects the chunk, which rejects NoteStore.open, openVaultContext and
// bootVault — and the boot path has no catch, so the window sits on its
// opening state forever. This asks whether that is reachable with files a real
// machine actually produces, not with something hand-crafted to break a parser.
import { initVault, loadNotes, createNote } from '../src/index.js'
import { mkdir, mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_TMP = fileURLToPath(new URL('../../../tmp/', import.meta.url))
await mkdir(REPO_TMP, { recursive: true })

interface Case {
  name: string
  write: (notesDir: string) => Promise<void>
}

const CASES: Case[] = [
  {
    name: 'malformed YAML frontmatter (a tab in indentation)',
    write: async (d) => writeFile(join(d, 'bad-yaml.md'), '---\ntitle: x\n\tstatus: seed\n---\n\nbody\n'),
  },
  {
    name: 'unterminated frontmatter fence',
    write: async (d) => writeFile(join(d, 'no-close.md'), '---\ntitle: x\n\nbody with no closing fence\n'),
  },
  {
    name: 'frontmatter value that is a duplicate key',
    write: async (d) => writeFile(join(d, 'dupe.md'), '---\nstatus: seed\nstatus: grown\n---\n\nbody\n'),
  },
  {
    name: 'invalid UTF-8 bytes (a file copied from a cp949 editor)',
    write: async (d) => writeFile(join(d, 'cp949.md'), Buffer.from([0xed, 0x95, 0x9c, 0xb0, 0xa1, 0xb3, 0xaa, 0x0a])),
  },
  {
    name: 'empty file (an editor crashed mid-save)',
    write: async (d) => writeFile(join(d, 'empty.md'), ''),
  },
  {
    name: 'frontmatter is a list, not a map',
    write: async (d) => writeFile(join(d, 'list-front.md'), '---\n- a\n- b\n---\n\nbody\n'),
  },
  {
    name: 'a directory named like a note (sync conflict folder)',
    write: async (d) => mkdir(join(d, 'folder.md'), { recursive: true }),
  },
  {
    name: 'unreadable file (locked by antivirus / another process)',
    write: async (d) => {
      const p = join(d, 'locked.md')
      await writeFile(p, '---\ntitle: x\n---\n\nbody\n')
      await chmod(p, 0o000).catch(() => undefined)
    },
  },
]

let bricks = 0
for (const c of CASES) {
  const root = await mkdtemp(join(REPO_TMP, 'brick-'))
  const paths = await initVault(root, { git: false })
  // A few good notes, so a failure means "lost the vault", not "lost one note".
  for (let i = 0; i < 3; i += 1) {
    await createNote(paths, { id: `good-${i}`, body: `# Good ${i}\n\nbody` })
  }
  await c.write(paths.notes)
  try {
    const skipped: string[] = []
    const notes = await loadNotes(paths, (s) => skipped.push(s.file))
    const good = notes.filter((n) => n.front.id.startsWith('good-')).length
    const named = skipped.length > 0 ? `named [${skipped.join(', ')}]` : 'nothing skipped'
    console.log(`  ok     ${good}/3 good notes survived, ${named}  —  ${c.name}`)
  } catch (err) {
    bricks += 1
    console.log(`  BRICK  ${(err as Error).message.slice(0, 70)}  —  ${c.name}`)
  }
}

console.log(`\n${bricks} of ${CASES.length} cases take the whole vault down.`)
