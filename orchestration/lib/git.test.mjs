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
    expect(await g.ensureBranch(opts, 'next', 'main')).toBe(true)
    expect(await g.ensureBranch(opts, 'next', 'main')).toBe(false)
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
