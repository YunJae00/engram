import { simpleGit, type SimpleGit } from 'simple-git'
import type { BinaryProvider } from './binary.js'
import { defaultBinaryProvider } from './binary.js'

export function bundledGitExecPath(provider: BinaryProvider): string | null {
  const bundled = provider as { gitExecPath?(): string | null }
  return bundled.gitExecPath?.() ?? null
}

// Environment for a bundled git: exec/template paths added, editor-related
// variables stripped — simple-git blocks them and we never open an editor.
export function bundledGitEnv(execPath: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (['EDITOR', 'VISUAL', 'GIT_EDITOR', 'GIT_SEQUENCE_EDITOR', 'GIT_PAGER'].includes(key)) continue
    env[key] = value
  }
  env['GIT_EXEC_PATH'] = execPath
  env['GIT_TEMPLATE_DIR'] = execPath.replace('libexec/git-core', 'share/templates')
  return env
}

// Thin git layer over the workspace directory. Only workspace/ is a repo — private/ is never one.
export class GitLayer {
  private git: SimpleGit

  constructor(
    readonly workdir: string,
    provider: BinaryProvider = defaultBinaryProvider,
  ) {
    // Bundled git needs its subcommand/template paths (BundledBinaryProvider).
    // The exec path comes from our own provider — never user input — so
    // simple-git's unsafe-config guard can be relaxed for it.
    const execPath = bundledGitExecPath(provider)
    this.git = simpleGit({
      baseDir: workdir,
      binary: provider.git(),
      // The hidden layer manages vault files byte-for-byte: no line-ending
      // rewrites on checkout/revert regardless of the machine's git config
      // (Windows installs default to autocrlf=true).
      config: ['core.autocrlf=false'],
      ...(execPath ? { unsafe: { allowUnsafeConfigPaths: true, allowUnsafeTemplateDir: true } } : {}),
    })
    if (execPath) this.git = this.git.env(bundledGitEnv(execPath))
  }

  async init(): Promise<void> {
    await this.git.init(['-b', 'main'])
    await this.git.addConfig('user.name', 'Engram')
    await this.git.addConfig('user.email', 'engram@local')
    await this.autoCommit('vault: initial commit')
  }

  async isRepo(): Promise<boolean> {
    return this.git.checkIsRepo()
  }

  // Commits everything that changed; returns the commit hash or null when clean.
  async autoCommit(message: string): Promise<string | null> {
    await this.git.add('-A')
    const status = await this.git.status()
    if (status.staged.length === 0 && status.files.length === 0) return null
    const result = await this.git.commit(message)
    return result.commit || null
  }

  // One-click undo: revert a commit as a new commit, history intact.
  async revertCommit(hash: string): Promise<void> {
    await this.git.raw(['revert', '--no-edit', hash])
  }

  async revertLast(): Promise<void> {
    await this.revertCommit('HEAD')
  }

  async log(maxCount = 20): Promise<{ hash: string; message: string }[]> {
    const entries = await this.git.log({ maxCount })
    return entries.all.map((e) => ({ hash: e.hash, message: e.message }))
  }

  // Raw git escape hatch (tooling/tests). The hidden layer keeps its own
  // vocabulary; callers pass argv directly.
  async raw(args: string[]): Promise<string> {
    return this.git.raw(args)
  }

  // Stop tracking a path while keeping the file on disk, and commit the
  // removal so it propagates on push — used to retire app-managed files
  // (AGENTS.md) from the synced repo so a backup never carries them.
  async untrack(relPath: string): Promise<boolean> {
    const tracked = await this.git.raw(['ls-files', '--', relPath])
    if (!tracked.trim()) return false
    await this.git.raw(['rm', '--cached', '--ignore-unmatch', '--', relPath])
    await this.autoCommit(`vault: retire ${relPath} from tracking (app-managed, not backed up)`)
    return true
  }
}
