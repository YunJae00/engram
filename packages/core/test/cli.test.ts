import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runCli, type CliIO } from '../src/cli/main.js'
import { loadNotes } from '../src/notes.js'
import { generateSampleVault } from '../src/sample-vault.js'
import { vaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

const MOCK_DIR = fileURLToPath(new URL('../../../fixtures/mock-responses', import.meta.url))

function collectIO(): { io: CliIO; lines: string[] } {
  const lines: string[] = []
  return { io: { out: (l) => lines.push(l), err: (l) => lines.push(`ERR ${l}`) }, lines }
}

describe('engram CLI', () => {
  it('init builds a vault with git history', async () => {
    const root = await tmpVaultRoot('cli-init')
    const { io } = collectIO()
    expect(await runCli(['init', root], io)).toBe(0)
    const paths = vaultPaths(root)
    await access(join(paths.workspace, 'AGENTS.md'))
    await access(join(paths.workspace, '.git'))
    await access(paths.privateDir)
  }, 120_000)

  it('capture --no-run parks text in the inbox', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('cli-capture'))
    const { io } = collectIO()
    expect(await runCli(['capture', '회의 메모입니다', '--vault', paths.root, '--no-run'], io)).toBe(0)
    expect((await readdir(paths.inbox)).length).toBe(1)
  })

  it('capture --private lands outside the workspace and skips engines', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('cli-private'))
    const { io, lines } = collectIO()
    expect(await runCli(['capture', '비밀 메모', '--private', '--vault', paths.root], io)).toBe(0)
    expect((await readdir(paths.privateDir)).length).toBe(1)
    expect((await readdir(paths.inbox)).length).toBe(0)
    expect(lines.join('\n')).toContain('private')
  })

  it('capture with the mock engine turns text into a note', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('cli-capture-run'))
    const before = (await loadNotes(paths)).length
    const { io } = collectIO()
    const code = await runCli(
      ['capture', '주간 회의: 금요일 배포', '--vault', paths.root, '--engine', 'mock', '--mock-dir', MOCK_DIR],
      io,
    )
    expect(code).toBe(0)
    expect((await loadNotes(paths)).length).toBe(before + 1)
    expect((await readdir(paths.inbox)).length).toBe(0)
  })

  it('search finds seeded notes with badges', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('cli-search'))
    const { io, lines } = collectIO()
    expect(await runCli(['search', 'deploy', '--vault', paths.root], io)).toBe(0)
    expect(lines.join('\n')).toContain('n-deploy-0003')
  })

  it('cards list shows proposals after a sweep', async () => {
    const { paths } = await generateSampleVault(await tmpVaultRoot('cli-cards'))
    await runCli(['sweep', '--vault', paths.root, '--engine', 'mock', '--mock-dir', MOCK_DIR], collectIO().io)
    const { io, lines } = collectIO()
    expect(await runCli(['cards', 'list', '--vault', paths.root], io)).toBe(0)
    expect(lines.join('\n')).toContain('[conflict]')
  })

  it('rejects unknown commands with usage help', async () => {
    const { io, lines } = collectIO()
    expect(await runCli(['frobnicate'], io)).toBe(1)
    expect(lines.join('\n')).toContain('unknown command')
  })
})
