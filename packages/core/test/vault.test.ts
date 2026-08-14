import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { GitLayer } from '../src/git.js'
import { initVault, type VaultPaths } from '../src/vault.js'
import { tmpVaultRoot } from './helpers.js'

describe('vault initialization', () => {
  let paths: VaultPaths

  beforeAll(async () => {
    paths = await initVault(await tmpVaultRoot('vault'), { git: false })
  })

  it('creates the full EngramRoot layout', async () => {
    for (const dir of [paths.workspace, paths.notes, paths.inbox, paths.sources, paths.views, paths.cache, paths.privateDir]) {
      expect((await stat(dir)).isDirectory()).toBe(true)
    }
  })

  it('writes AGENTS.md v1 with every required section', async () => {
    const agents = await readFile(join(paths.workspace, 'AGENTS.md'), 'utf8')
    for (const section of ['Schema', 'Job procedures', 'When to supersede', 'Decay assignment', 'Card JSON format', 'Prohibitions', 'Counterexamples']) {
      expect(agents).toContain(section)
    }
  })

  it('keeps _views, .engram AND AGENTS.md out of sync via workspace .gitignore', async () => {
    const ignore = await readFile(join(paths.workspace, '.gitignore'), 'utf8')
    expect(ignore).toContain('_views/')
    expect(ignore).toContain('.engram/')
    // AGENTS.md is app IP — never backed up to a user's GitHub.
    expect(ignore).toMatch(/^AGENTS\.md$/m)
  })
})

describe('AGENTS.md is app-managed, never tracked (2026-07-23)', () => {
  it('a fresh vault never tracks AGENTS.md, and an existing vault gets it retired', async () => {
    const root = await tmpVaultRoot('agents-untrack')
    const paths = await initVault(root, { git: true })
    const git = new GitLayer(paths.workspace)
    const tracked = async () => git.raw(['ls-files'])
    // fresh vault: AGENTS.md exists on disk but git never staged it
    expect((await readFile(join(paths.workspace, 'AGENTS.md'), 'utf8')).length).toBeGreaterThan(0)
    expect(await tracked()).not.toContain('AGENTS.md')

    // simulate a legacy vault that committed AGENTS.md, then re-run initVault
    await git.raw(['add', '--force', 'AGENTS.md'])
    await git.raw(['commit', '-m', 'legacy: track AGENTS.md'])
    expect(await tracked()).toContain('AGENTS.md')
    await initVault(root, { git: true })
    expect(await tracked()).not.toContain('AGENTS.md')
    // the file itself is untouched on disk
    expect((await readFile(join(paths.workspace, 'AGENTS.md'), 'utf8')).length).toBeGreaterThan(0)
  }, 120_000)
})

describe('git layer (BinaryProvider)', () => {
  it('init + autoCommit + revertLast round-trip', async () => {
    const paths = await initVault(await tmpVaultRoot('git'), { git: true })
    const git = new GitLayer(paths.workspace)
    expect(await git.isRepo()).toBe(true)

    const file = join(paths.notes, 'n-test-0001.md')
    await writeFile(file, 'version 1\n')
    const first = await git.autoCommit('note: v1')
    expect(first).toBeTruthy()

    await writeFile(file, 'version 2\n')
    const second = await git.autoCommit('note: v2')
    expect(second).toBeTruthy()
    expect(await git.autoCommit('empty')).toBeNull()

    await git.revertLast()
    expect(await readFile(file, 'utf8')).toBe('version 1\n')
    const log = await git.log()
    expect(log.length).toBeGreaterThanOrEqual(4) // init, v1, v2, revert
    // Matches the global vitest timeout: many git spawns competing with the
    // rest of the parallel suite for disk (and AV scanning) need the headroom.
  }, 120_000)
})
