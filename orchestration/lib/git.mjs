import { execFile } from 'node:child_process'
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

export async function ensureBranch({ root, remote }, base, from) {
  if (await gitOrNull(root, ['ls-remote', '--exit-code', '--heads', remote, base])) return false
  await git(root, ['push', remote, `${from}:refs/heads/${base}`])
  return true
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
