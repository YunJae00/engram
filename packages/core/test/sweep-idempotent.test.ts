import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIO } from '../src/cli/main.js'
import { generateSampleVault } from '../src/sample-vault.js'
import type { VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const MOCK_DIR = fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url))

function collectIO(): { io: CliIO; lines: string[] } {
  const lines: string[] = []
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) }, lines }
}

// Everything the sweep may touch: notes + all generated views (cards, brief,
// logs). Two consecutive sweeps must leave this snapshot byte-identical.
async function snapshotWorkspace(paths: VaultPaths): Promise<Map<string, string>> {
  const snapshot = new Map<string, string>()
  const walk = async (dir: string, prefix: string) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) await walk(path, `${prefix}${entry.name}/`)
      else snapshot.set(`${prefix}${entry.name}`, await readFile(path, 'utf8'))
    }
  }
  await walk(paths.notes, 'notes/')
  await walk(paths.views, '_views/')
  return snapshot
}

describe('engram sweep idempotency (M2 acceptance)', () => {
  it('two consecutive sweeps: the second changes nothing', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('idem'))

    const first = collectIO()
    const code1 = await runCli(
      ['sweep', '--vault', paths.root, '--engine', 'mock', '--mock-dir', MOCK_DIR],
      first.io,
    )
    expect(code1).toBe(0)
    expect(first.lines.join('\n')).toMatch(/[1-9]d* run/)

    const before = await snapshotWorkspace(paths)
    expect([...before.keys()].some((k) => k.startsWith('_views/cards/'))).toBe(true)

    const second = collectIO()
    const code2 = await runCli(
      ['sweep', '--vault', paths.root, '--engine', 'mock', '--mock-dir', MOCK_DIR],
      second.io,
    )
    expect(code2).toBe(0)
    expect(second.lines.join('\n')).toMatch(/0 run/)

    const after = await snapshotWorkspace(paths)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    for (const [file, content] of before) expect(after.get(file), file).toBe(content)
  }, 120_000)
})
