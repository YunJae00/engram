import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inferTypeFromFolder, reclassifyImported, runImport } from '../src/import.js'
import { loadNotes } from '../src/notes.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

describe('import folder-type inference', () => {
  it('maps known folder names (en + ko) and leaves the rest alone', () => {
    expect(inferTypeFromFolder('decisions/stack.md')).toBe('decision')
    expect(inferTypeFromFolder('결정/stack.md')).toBe('decision')
    expect(inferTypeFromFolder('troubleshooting/eperm.md')).toBe('troubleshooting')
    expect(inferTypeFromFolder('howto/build.md')).toBe('howto')
    expect(inferTypeFromFolder('log/2026-05-02.md')).toBe('log')
    expect(inferTypeFromFolder('concepts/lineage.md')).toBe('concept')
    expect(inferTypeFromFolder('random-stuff/note.md')).toBeNull()
    // a file at the import root has no folder to read
    expect(inferTypeFromFolder('note.md')).toBeNull()
    // windows separators
    expect(inferTypeFromFolder('decisions\\stack.md')).toBe('decision')
  })

  it('runImport applies the inferred type; explicit frontmatter wins; unmapped stays imported', async () => {
    const paths = await initVault(await tmpVaultRoot('import-types'), { git: false })
    const source = join(await tmpVaultRoot('import-types-src'), 'vault')
    await mkdir(join(source, 'decisions'), { recursive: true })
    await mkdir(join(source, 'misc'), { recursive: true })
    await writeFile(join(source, 'decisions', 'a.md'), '# Decided A\n\nbody')
    await writeFile(join(source, 'decisions', 'b.md'), '---\ntype: fact\n---\n# Actually a fact\n\nbody')
    await writeFile(join(source, 'misc', 'c.md'), '# Loose note\n\nbody')

    await runImport(paths, source)
    const byTitle = new Map((await loadNotes(paths)).map((n) => [n.body.split('\n')[0], n.front.type]))
    expect(byTitle.get('# Decided A')).toBe('decision')
    expect(byTitle.get('# Actually a fact')).toBe('fact')
    expect(byTitle.get('# Loose note')).toBe('imported')
  })

  it('reclassifyImported repairs pre-inference notes without touching updated, idempotently', async () => {
    const paths = await initVault(await tmpVaultRoot('import-reclass'), { git: false })
    const source = join(await tmpVaultRoot('import-reclass-src'), 'vault')
    await mkdir(join(source, 'howto'), { recursive: true })
    // Explicit frontmatter simulates a pre-inference import: type stays 'imported'.
    await writeFile(join(source, 'howto', 'guide.md'), '---\ntype: imported\n---\n# Old import\n\nbody')
    await mkdir(join(source, 'misc'), { recursive: true })
    await writeFile(join(source, 'misc', 'loose.md'), '---\ntype: imported\n---\n# Stays imported\n\nbody')
    await runImport(paths, source)

    const before = new Map((await loadNotes(paths)).map((n) => [n.front.id, n.front.updated]))
    const changed = await reclassifyImported(paths)
    expect(changed).toBe(1)

    const after = await loadNotes(paths)
    const guide = after.find((n) => n.body.startsWith('# Old import'))!
    const loose = after.find((n) => n.body.startsWith('# Stays imported'))!
    expect(guide.front.type).toBe('howto')
    expect(loose.front.type).toBe('imported')
    // metadata correction must not re-enter the sweep delta
    expect(guide.front.updated).toBe(before.get(guide.front.id))

    expect(await reclassifyImported(paths)).toBe(0)
  })
})
