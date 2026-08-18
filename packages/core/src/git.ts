import { simpleGit, type SimpleGit } from 'simple-git'
import type { BinaryProvider } from './binary.js'
import { defaultBinaryProvider } from './binary.js'

export function bundledGitExecPath(provider: BinaryProvider): string | null {
  const bundled = provider as { gitExecPath?(): string | null }
  return bundled.gitExecPath?.() ?? null
}

// simple-git refuses to forward the variables that let an environment turn a
// git call into arbitrary command execution — editors, pagers, askpass and ssh
// helpers, config-path overrides — and throws on the whole command rather than
// dropping them, so they never reach the env we hand it. None is wanted here:
// nothing opens an editor or pages output, and an askpass helper is the very
// thing GIT_TERMINAL_PROMPT below exists to rule out.
const UNFORWARDABLE_ENV = new Set([
  'EDITOR',
  'VISUAL',
  'PAGER',
  'PREFIX',
  'SSH_ASKPASS',
  'GIT_ASKPASS',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_EDITOR',
  'GIT_EXEC_PATH',
  'GIT_EXTERNAL_DIFF',
  'GIT_PAGER',
  'GIT_PROXY_COMMAND',
  'GIT_SEQUENCE_EDITOR',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TEMPLATE_DIR',
])

// Environment for a git child: the process env minus what simple-git blocks.
export function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (UNFORWARDABLE_ENV.has(key.toUpperCase())) continue
    env[key] = value
  }
  // There is no terminal behind these calls. Without this a remote that wants
  // credentials leaves git waiting on a prompt nobody can answer, and only the
  // block timeout ends it — an immediate auth error is far more useful.
  env['GIT_TERMINAL_PROMPT'] = '0'
  return env
}

// Environment for a bundled git: its subcommand/template paths added back.
export function bundledGitEnv(execPath: string): Record<string, string> {
  const env = gitEnv()
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
      // simple-git spawns git itself, so these children are outside the spawn
      // ledger and nothing reaps them: a call that waits — on a remote, on an
      // index lock, on a credential helper — blocks its caller (the coalesced
      // auto-commit) forever and outlives a force-quit, dragging any helper
      // processes with it. A failed git is recoverable, the next commit retries;
      // a blocked one is not. simple-git kills the child when it has been silent
      // for this long, which no local git operation ever is.
      timeout: { block: 30_000 },
      ...(execPath ? { unsafe: { allowUnsafeConfigPaths: true, allowUnsafeTemplateDir: true } } : {}),
    })
    this.git = this.git.env(execPath ? bundledGitEnv(execPath) : gitEnv())
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
