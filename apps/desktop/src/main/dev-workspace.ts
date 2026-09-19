import { randomUUID } from 'node:crypto'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, join, relative, isAbsolute } from 'node:path'
import { bundledGitEnv, gitEnv } from 'core'
import { ProcessClient } from './process-client.js'
import { binaryProvider } from './vault.js'
import type { DevGitState, DevRepo } from '../shared/developers.js'

export async function canonicalRepo(path: string): Promise<string> {
  const root = await realpath(path)
  if (!(await stat(root)).isDirectory()) throw new Error('Choose a project folder.')
  return root
}

export function runDevGit(cwd: string, args: string[], hooks: string): Promise<string> {
  const provider = binaryProvider(), execPath = provider.gitExecPath()
  const env = execPath ? bundledGitEnv(execPath) : gitEnv()
  return new Promise((resolve, reject) => {
    const child = new ProcessClient(provider.git(), ['--no-pager', '--literal-pathspecs', '-c', `core.hooksPath=${hooks}`, ...args], { cwd, env })
    let output = '', errorText = '', finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true; clearTimeout(timer)
      if (error) { child.kill(); reject(error) } else resolve(output)
    }
    const timer = setTimeout(() => finish(new Error('The Git operation timed out. Inspect the repository before retrying.')), 120_000)
    child.on('error', error => finish(error))
    child.stdout.on('data', chunk => {
      output += chunk.toString()
      if (output.length > 2_000_000) finish(new Error('This Git result is too large to preview. Narrow the change set in your editor.'))
    })
    child.stderr.on('data', chunk => { errorText = (errorText + chunk.toString()).slice(-4000) })
    child.on('close', code => finish(code === 0 ? undefined : new Error(errorText.trim() || 'Git could not complete this operation.')))
  })
}

export function statusFiles(text: string): DevGitState['files'] {
  const entries = text.split('\0'), files: DevGitState['files'] = []
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.length < 4) continue
    const status = entry.slice(0, 2), path = entry.slice(3)
    const previousPath = /[RC]/.test(status) ? entries[++index] : undefined
    files.push({ status, path, ...(previousPath ? { previousPath } : {}) })
  }
  return files
}

export async function devGitState(cwd: string, hooks: string): Promise<DevGitState> {
  const [status, branch, diff] = await Promise.all([
    runDevGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], hooks),
    runDevGit(cwd, ['branch', '--show-current'], hooks),
    runDevGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], hooks).catch(async error => {
      if (/unknown revision|bad revision|ambiguous argument/.test(error.message)) return runDevGit(cwd, ['diff', '--no-ext-diff', '--no-textconv', '--'], hooks)
      throw error
    }),
  ])
  return { branch: branch.trim() || 'Detached HEAD', files: statusFiles(status), diff: diff.slice(0, 200_000), truncated: diff.length > 200_000 }
}

export async function devWorktree(repo: DevRepo, managedRoot: string, hooks: string): Promise<{ cwd: string; branch: string }> {
  await mkdir(managedRoot, { recursive: true })
  const parent = await realpath(managedRoot), id = randomUUID(), cwd = join(parent, id), branch = `engram/${id}`
  await runDevGit(repo.path, ['worktree', 'add', '-b', branch, cwd, 'HEAD'], hooks)
  return { cwd: await canonicalRepo(cwd), branch }
}

export async function devCommit(cwd: string, paths: string[], message: string, hooks: string): Promise<void> {
  if (!Array.isArray(paths) || !paths.length || paths.length > 200 || typeof message !== 'string' || !message.trim() || message.length > 4000) throw new Error('Choose files and enter a commit message.')
  const state = await devGitState(cwd, hooks), available = new Set(state.files.map(file => file.path))
  const commitPaths = new Set(paths)
  for (const path of paths) {
    if (typeof path !== 'string' || !available.has(path) || isAbsolute(path) || relative(cwd, join(cwd, path)).startsWith('..') || basename(path) === '.git') throw new Error('The selected files changed. Refresh the review.')
    const file = state.files.find(file => file.path === path)
    if (file?.status.includes('R') && file.previousPath) commitPaths.add(file.previousPath)
  }
  // Only selected paths are committed; unrelated staged work is left in the index.
  await runDevGit(cwd, ['add', '--', ...paths], hooks)
  await runDevGit(cwd, ['commit', '--only', '-m', message.trim(), '--', ...commitPaths], hooks)
}
