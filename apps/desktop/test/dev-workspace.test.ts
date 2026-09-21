import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'

vi.mock('../src/main/process-client.js', () => ({ ProcessClient: function (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) { return spawn(command, args, { ...options, env: { ...options.env, GIT_CEILING_DIRECTORIES: dirname(options.cwd) } }) } }))
vi.mock('../src/main/vault.js', () => ({ binaryProvider: () => ({ git: () => 'git', gitExecPath: () => undefined }) }))
import { devCommit, devGitState, devWorktree, runDevGit, statusFiles } from '../src/main/dev-workspace.js'
import { devFileReview, devUndoHunk } from '../src/main/dev-review.js'

it('parses renamed and spaced paths without confusing the old path for another change', () => {
  expect(statusFiles('R  next name.txt\0old name.txt\0 M other.txt\0?? new.txt\0')).toEqual([
    { status: 'R ', path: 'next name.txt', previousPath: 'old name.txt' }, { status: ' M', path: 'other.txt' }, { status: '??', path: 'new.txt' },
  ])
})

it('isolates work and commits only selected changes without consuming unrelated staged work', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/dev-git-')), repo = join(root, 'repo'), hooks = join(root, 'empty-hooks')
  await mkdir(repo); await mkdir(hooks)
  const git = (args: string[]) => runDevGit(repo, args, hooks)
  // The fixture process ceiling prevents discovery of the user's parent repository.
  const plain = join(root, 'plain')
  await mkdir(plain)
  await expect(devWorktree({ id: 'plain', name: 'plain', path: plain }, join(root, 'worktrees'), hooks)).rejects.toThrow('needs a Git repository')
  expect(await readdir(plain)).toEqual([])
  await git(['init'])
  await expect(devWorktree({ id: 'repo', name: 'repo', path: repo }, join(root, 'worktrees'), hooks)).rejects.toThrow('at least one commit')
  await git(['config', 'user.name', 'Fixture'])
  await git(['config', 'user.email', 'fixture@example.invalid'])
  await git(['config', 'commit.gpgsign', 'false'])
  await writeFile(join(repo, 'first.txt'), 'before\n')
  await writeFile(join(repo, 'second.txt'), 'before\n')
  await git(['add', '.']); await git(['commit', '-m', 'Initial fixture'])
  const work = await devWorktree({ id: 'repo', name: 'repo', path: repo }, join(root, 'worktrees'), hooks)
  await writeFile(join(work.cwd, 'first.txt'), 'isolated\n')
  expect(await readFile(join(repo, 'first.txt'), 'utf8')).toBe('before\n')
  await writeFile(join(repo, 'first.txt'), 'selected\n')
  await writeFile(join(repo, 'second.txt'), 'unrelated staged\n')
  await git(['add', 'second.txt'])
  await devCommit(repo, ['first.txt'], 'Selected change', hooks)
  expect(await git(['show', 'HEAD:first.txt'])).toBe('selected\n')
  expect(await git(['show', 'HEAD:second.txt'])).toBe('before\n')
  expect((await devGitState(repo, hooks)).files).toEqual([{ path: 'second.txt', status: 'M ' }])
  await expect(devCommit(repo, ['../outside'], 'Rejected', hooks)).rejects.toThrow()
  const review = await devFileReview(repo, 'second.txt', hooks)
  await writeFile(join(repo, 'second.txt'), 'Changed during review\n')
  await expect(devUndoHunk(repo, 'second.txt', review.fingerprint, 0, hooks, join(root, 'backups'))).rejects.toThrow('changed after')
  const fresh = await devFileReview(repo, 'second.txt', hooks)
  const result = await devUndoHunk(repo, 'second.txt', fresh.fingerprint, 0, hooks, join(root, 'backups'))
  expect(await readFile(join(repo, 'second.txt'), 'utf8')).toBe('before\n')
  expect(JSON.parse(await readFile(result.backup, 'utf8')).before).toBe('Changed during review\n')
  expect(await git(['show', ':second.txt'])).toBe('unrelated staged\n')
  await git(['mv', 'first.txt', 'renamed.txt'])
  await devCommit(repo, ['renamed.txt'], 'Rename selected file', hooks)
  expect(await git(['show', 'HEAD:renamed.txt'])).toBe('selected\n')
  await expect(git(['show', 'HEAD:first.txt'])).rejects.toThrow()
  expect(await git(['show', ':second.txt'])).toBe('unrelated staged\n')
}, 120_000)
