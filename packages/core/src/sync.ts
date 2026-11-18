import { simpleGit, type SimpleGit } from 'simple-git'
import type { BinaryProvider } from './binary.js'
import { defaultBinaryProvider } from './binary.js'
import { bundledGitEnv, bundledGitExecPath, gitEnv, keepLocalOnly } from './git.js'
import { initVault, vaultPaths, type VaultPaths } from './vault.js'

export interface SyncStatus {
  state: 'clean' | 'ahead' | 'behind' | 'diverged' | 'no-remote'
  ahead: number
  behind: number
}

export interface PullResult {
  pulled: boolean
  conflicts: string[]
}

export class TeamSync {
  private git: SimpleGit

  constructor(
    readonly paths: VaultPaths,
    provider: BinaryProvider = defaultBinaryProvider,
  ) {
    const execPath = bundledGitExecPath(provider)
    this.git = simpleGit({
      baseDir: paths.workspace,
      binary: provider.git(),
      timeout: { block: 10 * 60_000 },
      ...(execPath ? { unsafe: { allowUnsafeConfigPaths: true, allowUnsafeTemplateDir: true } } : {}),
    })
    this.git = this.git.env(execPath ? bundledGitEnv(execPath) : gitEnv())
  }

  async hasRemote(): Promise<boolean> {
    return (await this.git.getRemotes()).some((r) => r.name === 'origin')
  }

  async remoteUrl(): Promise<string | null> {
    const origin = (await this.git.getRemotes(true)).find((r) => r.name === 'origin')
    return origin?.refs?.push ?? origin?.refs?.fetch ?? null
  }

  async disconnect(): Promise<void> {
    if (await this.hasRemote()) await this.git.removeRemote('origin')
  }

  async createTeam(remoteUrl: string): Promise<void> {
    await this.git.addRemote('origin', remoteUrl)
    await this.git.push(['-u', 'origin', 'main'])
  }

  async status(options: { fetch?: boolean } = {}): Promise<SyncStatus> {
    if (!(await this.hasRemote())) return { state: 'no-remote', ahead: 0, behind: 0 }
    if (options.fetch !== false) await this.git.fetch()
    const ahead = Number((await this.git.raw(['rev-list', '--count', 'origin/main..HEAD'])).trim())
    const behind = Number((await this.git.raw(['rev-list', '--count', 'HEAD..origin/main'])).trim())
    if (ahead > 0 && behind > 0) return { state: 'diverged', ahead, behind }
    if (ahead > 0) return { state: 'ahead', ahead, behind }
    if (behind > 0) return { state: 'behind', ahead, behind }
    return { state: 'clean', ahead: 0, behind: 0 }
  }

  async pull(): Promise<PullResult> {
    if (!(await this.hasRemote())) return { pulled: false, conflicts: [] }
    await this.git.fetch()
    try {
      await this.git.merge(['origin/main', '--no-edit'])
      return { pulled: true, conflicts: [] }
    } catch {
      const status = await this.git.status()
      return { pulled: false, conflicts: status.conflicted }
    }
  }

  async commitAll(message: string): Promise<void> {
    await keepLocalOnly(this.paths.workspace)
    await this.git.add('-A')
    const status = await this.git.status()
    if (status.staged.length > 0 || status.files.length > 0) await this.git.commit(message)
  }

  async push(): Promise<void> {
    if (!(await this.hasRemote())) return
    await this.git.push('origin', 'main')
  }

  async incomingDiff(): Promise<string> {
    await this.git.fetch()
    return this.git.raw(['diff', '--stat', 'HEAD...origin/main'])
  }

  raw(): SimpleGit {
    return this.git
  }
}

export async function joinTeam(
  root: string,
  remoteUrl: string,
  provider: BinaryProvider = defaultBinaryProvider,
): Promise<VaultPaths> {
  const paths = vaultPaths(root)
  const git = simpleGit({ binary: provider.git() })
  await git.clone(remoteUrl, paths.workspace)
  const clonedGit = simpleGit({ baseDir: paths.workspace, binary: provider.git() })
  await clonedGit.addConfig('user.name', 'Engram')
  await clonedGit.addConfig('user.email', 'engram@local')
  await initVault(root, { git: false })
  return paths
}
