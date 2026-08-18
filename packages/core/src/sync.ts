import { simpleGit, type SimpleGit } from 'simple-git'
import type { BinaryProvider } from './binary.js'
import { defaultBinaryProvider } from './binary.js'
import { bundledGitEnv, bundledGitExecPath, gitEnv } from './git.js'
import { initVault, vaultPaths, type VaultPaths } from './vault.js'

// Team sync: workspace/ is the repo; the UI never says "git".
// States map to ✓ / ↑n / ↓n / conflict.

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
      // Generous, because this is the one git that talks to a network: a first
      // push of a large vault is legitimately silent for minutes (git reports
      // no progress when stderr is a pipe), so a short budget would kill real
      // backups. It exists to end the failures that never resolve on their own
      // — an unreachable host, a stalled TLS handshake — rather than to hurry
      // a slow transfer. simple-git spawns git outside this package's process
      // ledger, so a hang here is a child nothing reaps.
      timeout: { block: 10 * 60_000 },
      ...(execPath ? { unsafe: { allowUnsafeConfigPaths: true, allowUnsafeTemplateDir: true } } : {}),
    })
    // Unconditionally, not only for the bundled git: GIT_TERMINAL_PROMPT=0 is
    // what turns a credential prompt into a fast failure instead of a child
    // waiting forever on a terminal that no desktop app has.
    this.git = this.git.env(execPath ? bundledGitEnv(execPath) : gitEnv())
  }

  async hasRemote(): Promise<boolean> {
    return (await this.git.getRemotes()).some((r) => r.name === 'origin')
  }

  // The origin URL, or null if none is set — lets a caller tell "already backed
  // up to THIS repo" (retry a failed push) from "connected to a DIFFERENT repo".
  async remoteUrl(): Promise<string | null> {
    const origin = (await this.git.getRemotes(true)).find((r) => r.name === 'origin')
    return origin?.refs?.push ?? origin?.refs?.fetch ?? null
  }

  async createTeam(remoteUrl: string): Promise<void> {
    await this.git.addRemote('origin', remoteUrl)
    await this.git.push(['-u', 'origin', 'main'])
  }

  // `fetch: false` answers from the refs already on disk — no network, no
  // subprocess beyond two cheap rev-lists. The badge in the top bar polls this
  // once a minute forever, and with a fetch in it that was a network round trip
  // every 60 seconds for the life of the process on every vault with a remote:
  // battery, bandwidth, and a UI that stalls behind a slow or captive network.
  // The 5-minute auto-sync and an explicit Sync now still fetch, so the numbers
  // the badge shows are never more than one sync cycle stale.
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

  // Pull with merge; conflicts are reported, never left half-resolved here —
  // the conflict pipeline (conflict.ts) takes over while the merge is open.
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
    await this.git.add('-A')
    const status = await this.git.status()
    if (status.staged.length > 0 || status.files.length > 0) await this.git.commit(message)
  }

  async push(): Promise<void> {
    if (!(await this.hasRemote())) return
    await this.git.push('origin', 'main')
  }

  // The human-language incoming diff the librarian narrates (↓ click).
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
  // ensure the non-synced parts of the layout exist
  await initVault(root, { git: false })
  return paths
}
