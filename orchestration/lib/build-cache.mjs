import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import process from 'node:process'
import { dirname, join } from 'node:path'
import { git } from './runtime.mjs'

// What `pnpm --filter desktop build` writes; both are gitignored, so a fresh worktree has neither.
export const BUILD_OUTPUTS = ['apps/desktop/out', 'apps/desktop/native-bin']
const ENTRY = 'apps/desktop/out/main/index.js'
const KEEP = 3

// The build depends only on the committed tree, so a worktree without tracked edits is keyed by its tree SHA.
// shortcut: untracked source files are not part of the key; verifier worktrees are fresh checkouts, so none exist there.
export async function buildCacheDir(worktree) {
  try {
    if ((await git(worktree, 'status', '--porcelain', '--untracked-files=no')).trim()) return null
    const tree = (await git(worktree, 'rev-parse', 'HEAD^{tree}')).trim()
    const common = (await git(worktree, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim()
    return join(dirname(common), 'tmp/desktop-build', tree)
  } catch {
    return null
  }
}

const copyOutputs = (from, to) => {
  for (const rel of BUILD_OUTPUTS) {
    if (existsSync(join(from, rel))) cpSync(join(from, rel), join(to, rel), { recursive: true, force: true, verbatimSymlinks: true })
  }
}

/** Copies a cached desktop build for this worktree's tree into it; returns the cache dir, or null on a miss. */
export async function restoreBuild(worktree) {
  const dir = await buildCacheDir(worktree)
  if (!dir || !existsSync(join(dir, ENTRY))) return null
  for (const rel of BUILD_OUTPUTS) rmSync(join(worktree, rel), { recursive: true, force: true })
  copyOutputs(dir, worktree)
  return dir
}

/** Stores this worktree's desktop build under its tree SHA; keeps only the newest few trees. */
export async function saveBuild(worktree) {
  const dir = await buildCacheDir(worktree)
  if (!dir || existsSync(dir) || !existsSync(join(worktree, ENTRY))) return
  // Copy into a staging dir and rename, so a concurrent restore never sees half a build.
  const staging = `${dir}.${process.pid}.tmp`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  copyOutputs(worktree, staging)
  try {
    renameSync(staging, dir)
  } catch {
    rmSync(staging, { recursive: true, force: true })
  }
  const root = dirname(dir)
  const trees = readdirSync(root).filter((n) => !n.endsWith('.tmp')).map((n) => join(root, n))
  trees.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  for (const old of trees.slice(KEEP)) rmSync(old, { recursive: true, force: true })
}
