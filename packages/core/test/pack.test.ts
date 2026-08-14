import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadNotes } from '../src/notes.js'
import { buildContextPack, writeContextPack } from '../src/pack.js'
import { generateSampleVault } from '../src/sample-vault.js'
import { tmpVaultRoot } from './helpers.js'

describe('context pack (M6 acceptance)', () => {
  it('includes only current notes and summarizes the lineage chain', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('pack'))
    const notes = await loadNotes(paths)
    const pack = buildContextPack(notes, { now: new Date('2026-07-01T00:00:00Z') })

    // current v3 present with its chain summary
    expect(pack).toContain('배포 절차 v3')
    expect(pack).toContain('lineage: supersedes')
    expect(pack).toContain('배포 절차 v2 (2026-03-05)')
    // superseded bodies are excluded
    expect(pack).not.toContain('수동 FTP 업로드')
    expect(pack).not.toContain('스테이징까지 자동 배포')
    // disputed pair excluded too (status !== current)
    expect(pack).not.toContain('월 5만원')
  })

  it('query filter narrows the pack', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('pack-query'))
    const notes = await loadNotes(paths)
    const pack = buildContextPack(notes, { query: '배포 절차' })
    expect(pack).toContain('배포 절차 v3')
    expect(pack).not.toContain('킥오프')
  })

  it('writes the pack under _views/', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('pack-write'))
    const notes = await loadNotes(paths)
    const rel = await writeContextPack(paths, buildContextPack(notes))
    expect(rel).toMatch(/^_views\/pack-.+\.md$/)
    const content = await readFile(join(paths.workspace, rel), 'utf8')
    expect(content).toContain('# Context pack')
  })
})
