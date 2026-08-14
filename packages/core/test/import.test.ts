import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadAbsorbState, runImport, scanImportFolder, takeAbsorbBatch } from '../src/import.js'
import { loadNotes } from '../src/notes.js'
import { buildIndex, searchIndex } from '../src/search.js'
import { initVault } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

async function folderDigest(folder: string): Promise<string> {
  const hash = createHash('sha256')
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path)
      else hash.update(entry.name).update(await readFile(path))
    }
  }
  await walk(folder)
  return hash.digest('hex')
}

describe('bulk import (M7 acceptance)', () => {
  it('imports 500 fixture files: all searchable, queue loaded, originals untouched', async () => {
    const paths = await initVault(await tmpVaultRoot('import'), { git: false })
    const source = join(await tmpVaultRoot('import-src'), 'old-vault')
    await mkdir(join(source, 'sub'), { recursive: true })

    for (let i = 0; i < 500; i++) {
      const dir = i % 3 === 0 ? join(source, 'sub') : source
      const front = i % 5 === 0 ? `---\ntitle: legacy ${i}\ntype: fact\n---\n` : ''
      await writeFile(join(dir, `legacy-${String(i).padStart(3, '0')}.md`), `${front}# Legacy note ${i}\n\ntopic-marker-${i} body text.`)
    }

    const scan = await scanImportFolder(source)
    expect(scan.files).toHaveLength(500)
    expect(scan.totalBytes).toBeGreaterThan(0)

    const digestBefore = await folderDigest(source)
    const progress: number[] = []
    const report = await runImport(paths, source, { onProgress: (done) => progress.push(done) })
    expect(report.imported).toBe(500)
    expect(progress.at(-1)).toBe(500)

    // originals untouched (copy import)
    expect(await folderDigest(source)).toBe(digestBefore)

    // every import is a valid, searchable note immediately
    const notes = await loadNotes(paths)
    expect(notes.length).toBe(500)
    const index = buildIndex(notes)
    expect(searchIndex(index, 'topic-marker-337')[0]?.title).toContain('Legacy note 337')
    expect(searchIndex(index, 'topic-marker-42').length).toBeGreaterThan(0)

    // absorb queue carries all of them; the sweep drains in batches
    const state = await loadAbsorbState(paths)
    expect(state.pending).toHaveLength(500)
    expect(state.total).toBe(500)
    const batch = await takeAbsorbBatch(paths, 20)
    expect(batch).toHaveLength(20)
    expect((await loadAbsorbState(paths)).pending).toHaveLength(480)
  }, 300_000)

  it('maps existing frontmatter onto the schema', async () => {
    const paths = await initVault(await tmpVaultRoot('import-fm'), { git: false })
    const source = await tmpVaultRoot('import-fm-src')
    await writeFile(
      join(source, 'decision.md'),
      '---\ntype: decision\ndecay: evergreen\nhappened_at: 2025-11-01\n---\n# Old decision\n\nKeep the monolith.',
    )
    await runImport(paths, source)
    const [note] = await loadNotes(paths)
    expect(note!.front.type).toBe('decision')
    expect(note!.front.decay).toBe('evergreen')
    expect(note!.front.happened_at).toContain('2025-11-01')
    expect(note!.front.source).toBe('import:decision.md')
  })
})
