import { execFile } from 'node:child_process'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function git(cwd, args) {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim()
}

async function gitOrNull(cwd, args) {
  try {
    return await git(cwd, args)
  } catch {
    return null
  }
}

async function isAncestor(cwd, ancestor, descendant) {
  return (await gitOrNull(cwd, ['merge-base', '--is-ancestor', ancestor, descendant])) !== null
}

// null means base already contains `from`. Otherwise 'created' | 'fast-forward' | 'merged'.
export async function ensureBranch({ root, remote }, base, from) {
  const listed = await gitOrNull(root, ['ls-remote', '--exit-code', '--heads', remote, base])
  const fromSha = await git(root, ['rev-parse', from])
  if (!listed) {
    await git(root, ['push', remote, `${fromSha}:refs/heads/${base}`])
    return 'created'
  }
  const remoteSha = listed.split(/\s+/)[0]
  if (remoteSha === fromSha) return null
  await fetchBranch({ root, remote }, base)
  if (await isAncestor(root, remoteSha, fromSha)) {
    await git(root, ['push', remote, `${fromSha}:refs/heads/${base}`])
    return 'fast-forward'
  }
  if (await isAncestor(root, fromSha, remoteSha)) return null
  await mergeRemoteBranch({ root, remote }, base, from)
  return 'merged'
}

async function mergeRemoteBranch(opts, base, from) {
  const dir = join(opts.root, 'tmp', 'orch', `sync-${base}`)
  await git(opts.root, ['worktree', 'remove', '--force', dir]).catch(() => {})
  rmSync(dir, { recursive: true, force: true })
  await addWorktree(opts, dir, `${opts.remote}/${base}`, { detach: true })
  try {
    await git(dir, ['merge', '-m', `merge ${from} into ${base}`, from])
    await push(opts, dir, base)
  } catch (error) {
    await git(dir, ['merge', '--abort']).catch(() => {})
    throw error
  } finally {
    await removeWorktree(opts, dir)
  }
}

export async function addWorktree({ root }, path, ref, { detach = false } = {}) {
  await git(root, ['worktree', 'add', ...(detach ? ['--detach'] : []), path, ref])
}

export async function removeWorktree({ root }, path) {
  await git(root, ['worktree', 'remove', '--force', path])
}

export async function lsRemote({ root, remote }, branch) {
  const out = await git(root, ['ls-remote', '--heads', remote, branch])
  return out ? out.split(/\s+/)[0] : null
}

export async function fetchBranch({ root, remote }, branch) {
  await git(root, ['fetch', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
}

export async function fileAtRef({ root }, ref, path) {
  return gitOrNull(root, ['show', `${ref}:${path}`])
}

export async function changedFiles({ root }, base, ref) {
  const out = await git(root, ['diff', '--name-only', `${base}...${ref}`])
  return out ? out.split('\n') : []
}

export async function tipSha({ root }, ref) {
  return git(root, ['rev-parse', ref])
}

export async function lastCommitTime({ root }, ref) {
  return new Date(Number(await git(root, ['log', '-1', '--format=%ct', ref])) * 1000)
}

export async function squashMerge(_opts, worktree, branch, message) {
  await git(worktree, ['merge', '--squash', branch])
  await git(worktree, ['rm', '-r', '--cached', '--ignore-unmatch', '--quiet', 'orchestration/reports'])
  await git(worktree, ['commit', '-m', message])
  return git(worktree, ['rev-parse', 'HEAD'])
}

export async function push({ remote }, worktree, branch) {
  await git(worktree, ['push', remote, `HEAD:refs/heads/${branch}`])
}

export async function deleteRemoteBranch({ root, remote }, branch) {
  await git(root, ['push', remote, '--delete', branch])
}

export async function revert(_opts, worktree, sha, message) {
  await git(worktree, ['revert', '--no-edit', '--no-commit', sha])
  await git(worktree, ['commit', '-m', message])
  return git(worktree, ['rev-parse', 'HEAD'])
}
