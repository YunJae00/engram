import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as g from './git.mjs'

const base = resolve(import.meta.dirname, '../../tmp/orch-test', `git-${process.pid}`)
const remoteDir = join(base, 'remote.git')
const root = join(base, 'repo')
const opts = { root, remote: 'origin' }
const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

function commit(cwd, file, text, msg) {
  mkdirSync(join(cwd, file, '..'), { recursive: true })
  writeFileSync(join(cwd, file), text)
  sh(cwd, 'add', '-f', file)
  sh(cwd, 'commit', '-q', '-m', msg)
  return sh(cwd, 'rev-parse', 'HEAD')
}

beforeAll(() => {
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  sh(base, 'init', '-q', '--bare', '-b', 'main', remoteDir)
  sh(base, 'init', '-q', '-b', 'main', root)
  sh(root, 'config', 'user.name', 'Test')
  sh(root, 'config', 'user.email', 'test@example.com')
  sh(root, 'remote', 'add', 'origin', remoteDir)
  commit(root, 'a.txt', 'a\n', 'init')
  sh(root, 'push', '-q', 'origin', 'main')
})

afterAll(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('git', () => {
  it('ensureBranch creates the remote branch once', async () => {
    expect(await g.lsRemote(opts, 'next')).toBeNull()
    expect(await g.ensureBranch(opts, 'next', 'main')).toBe('created')
    expect(await g.ensureBranch(opts, 'next', 'main')).toBeNull()
    expect(await g.lsRemote(opts, 'next')).toBe(sh(root, 'rev-parse', 'main'))
  })

  it('squash merges a branch without reports or trailers, then reverts it', async () => {
    const work = join(base, 'work')
    sh(root, 'branch', 'orch/item', 'main')
    await g.addWorktree(opts, work, 'orch/item')
    const codeSha = commit(work, 'b.txt', 'b\n', 'add b')
    const reportSha = commit(work, 'orchestration/reports/item.json', '{}\n', 'report')
    await g.push(opts, work, 'orch/item')
    await g.removeWorktree(opts, work)

    expect(await g.lsRemote(opts, 'orch/item')).toBe(reportSha)
    await g.fetchBranch(opts, 'orch/item')
    expect(await g.tipSha(opts, 'origin/orch/item')).toBe(reportSha)
    expect(await g.tipSha(opts, 'origin/orch/item~1')).toBe(codeSha)
    expect(await g.tipSha(opts, 'orch/gone')).toBeNull()
    expect(await g.fileAtRef(opts, 'origin/orch/item', 'orchestration/reports/item.json')).toBe('{}')
    expect(await g.fileAtRef(opts, 'origin/orch/item', 'missing.txt')).toBeNull()
    expect((await g.changedFiles(opts, 'main', 'origin/orch/item')).sort())
      .toEqual(['b.txt', 'orchestration/reports/item.json'])
    expect(await g.lastCommitTime(opts, 'origin/orch/item')).toBeInstanceOf(Date)

    const next = join(base, 'next')
    await g.fetchBranch(opts, 'next')
    await g.addWorktree(opts, next, 'origin/next', { detach: true })
    const mergeSha = await g.squashMerge(opts, next, 'origin/orch/item', 'add b file')
    expect(sh(next, 'ls-tree', '-r', '--name-only', mergeSha).split('\n').sort()).toEqual(['a.txt', 'b.txt'])
    expect(sh(next, 'log', '-1', '--format=%B', mergeSha)).toBe('add b file')
    expect(sh(next, 'rev-list', '--parents', '-n', '1', mergeSha).split(' ')).toHaveLength(2)
    await g.push(opts, next, 'next')
    expect(await g.lsRemote(opts, 'next')).toBe(mergeSha)

    await g.deleteRemoteBranch(opts, 'orch/item')
    expect(await g.lsRemote(opts, 'orch/item')).toBeNull()

    const revertSha = await g.revert(opts, next, mergeSha, 'revert add b file')
    expect(sh(next, 'log', '-1', '--format=%B', revertSha)).toBe('revert add b file')
    expect(sh(next, 'ls-tree', '-r', '--name-only', revertSha)).toBe('a.txt')
    await g.removeWorktree(opts, next)
  })
})

describe('ensureBranch keeps an existing branch current', () => {
  const syncBase = resolve(import.meta.dirname, '../../tmp/orch-test', `git-sync-${process.pid}`)
  const remoteDir = join(syncBase, 'remote.git')
  const root = join(syncBase, 'repo')
  const opts = { root, remote: 'origin' }

  beforeAll(() => {
    rmSync(syncBase, { recursive: true, force: true })
    mkdirSync(syncBase, { recursive: true })
    sh(syncBase, 'init', '-q', '--bare', '-b', 'main', remoteDir)
    sh(syncBase, 'init', '-q', '-b', 'main', root)
    sh(root, 'config', 'user.name', 'Test')
    sh(root, 'config', 'user.email', 'test@example.com')
    sh(root, 'remote', 'add', 'origin', remoteDir)
    commit(root, 'a.txt', 'a\n', 'init')
    sh(root, 'push', '-q', 'origin', 'main')
  })

  afterAll(() => {
    rmSync(syncBase, { recursive: true, force: true })
  })

  it('fast-forwards, keeps commits main lacks, and merges when the branches diverge', async () => {
    expect(await g.ensureBranch(opts, 'next', 'main')).toBe('created')
    const moved = commit(root, 'm.txt', 'm\n', 'main moves')
    sh(root, 'push', '-q', 'origin', 'main')
    expect(await g.ensureBranch(opts, 'next', 'main')).toBe('fast-forward')
    expect(await g.lsRemote(opts, 'next')).toBe(moved)
    expect(await g.ensureBranch(opts, 'next', 'main')).toBeNull()

    const work = join(syncBase, 'next-only')
    await g.fetchBranch(opts, 'next')
    await g.addWorktree(opts, work, 'origin/next', { detach: true })
    const extra = commit(work, 'n.txt', 'n\n', 'next only')
    await g.push(opts, work, 'next')
    await g.removeWorktree(opts, work)
    expect(await g.ensureBranch(opts, 'next', 'main')).toBeNull()
    expect(await g.lsRemote(opts, 'next')).toBe(extra)

    const mainTip = commit(root, 'm2.txt', 'm2\n', 'main diverges')
    sh(root, 'push', '-q', 'origin', 'main')
    expect(await g.ensureBranch(opts, 'next', 'main')).toBe('merged')
    await g.fetchBranch(opts, 'next')
    const parents = sh(root, 'rev-list', '--parents', '-n', '1', 'origin/next').split(' ').slice(1)
    expect(new Set(parents)).toEqual(new Set([extra, mainTip]))
    expect(sh(root, 'ls-tree', '-r', '--name-only', 'origin/next').split('\n').sort()).toEqual(['a.txt', 'm.txt', 'm2.txt', 'n.txt'])
    sh(root, 'merge-base', '--is-ancestor', mainTip, 'origin/next')
  })

  it('leaves the branch in place when merging main would conflict', async () => {
    const clash = resolve(import.meta.dirname, '../../tmp/orch-test', `git-clash-${process.pid}`)
    const clashRemote = join(clash, 'remote.git')
    const clashRoot = join(clash, 'repo')
    const clashOpts = { root: clashRoot, remote: 'origin' }
    rmSync(clash, { recursive: true, force: true })
    mkdirSync(clash, { recursive: true })
    sh(clash, 'init', '-q', '--bare', '-b', 'main', clashRemote)
    sh(clash, 'init', '-q', '-b', 'main', clashRoot)
    sh(clashRoot, 'config', 'user.name', 'Test')
    sh(clashRoot, 'config', 'user.email', 'test@example.com')
    sh(clashRoot, 'remote', 'add', 'origin', clashRemote)
    commit(clashRoot, 'a.txt', 'base\n', 'init')
    sh(clashRoot, 'push', '-q', 'origin', 'main')
    try {
      expect(await g.ensureBranch(clashOpts, 'next', 'main')).toBe('created')
      const work = join(clash, 'next')
      await g.fetchBranch(clashOpts, 'next')
      await g.addWorktree(clashOpts, work, 'origin/next', { detach: true })
      const kept = commit(work, 'a.txt', 'next\n', 'next edits a')
      await g.push(clashOpts, work, 'next')
      await g.removeWorktree(clashOpts, work)
      commit(clashRoot, 'a.txt', 'main\n', 'main edits a')
      sh(clashRoot, 'push', '-q', 'origin', 'main')
      await expect(g.ensureBranch(clashOpts, 'next', 'main')).rejects.toThrow(/merge/)
      expect(await g.lsRemote(clashOpts, 'next')).toBe(kept)
      await g.fetchBranch(clashOpts, 'next')
      expect(sh(clashRoot, 'show', 'origin/next:a.txt')).toBe('next')
    } finally {
      rmSync(clash, { recursive: true, force: true })
    }
  })
})
