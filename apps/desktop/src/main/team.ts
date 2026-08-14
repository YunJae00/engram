import {
  collectResult,
  engineCwd,
  joinTeam,
  loadAbsorbState,
  resolveConflicts,
  runImport,
  TeamSync,
} from 'core'
import { ipcMain, shell } from 'electron'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import type { GithubConnectResultDto, SyncStatusDto } from '../shared/types.js'
import { broadcast, drainAbsorbQueue } from './ipc.js'
import { isAllowedExternalUrl } from './security.js'
import type { VaultContext } from './vault.js'

let teamSync: TeamSync | null = null

function syncOf(ctx: VaultContext): TeamSync {
  if (!teamSync) teamSync = new TeamSync(ctx.paths)
  return teamSync
}

// Turn whatever the user pasted into a canonical https clone URL. The bundled
// git's credential manager pops a browser login for https on Windows, so we
// always normalize to https — accepting the three shapes people copy:
//   https://github.com/user/repo(.git)   git@github.com:user/repo(.git)   user/repo
function normalizeGithubUrl(raw: string): string {
  const s = raw.trim()
  const ssh = s.match(/^git@github\.com:(.+?)(?:\.git)?\/?$/i)
  if (ssh?.[1]) return `https://github.com/${ssh[1]}.git`
  const https = s.match(/^https?:\/\/github\.com\/(.+?)(?:\.git)?\/?$/i)
  if (https?.[1]) return `https://github.com/${https[1]}.git`
  const bare = s.match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/)
  if (bare?.[1]) return `https://github.com/${bare[1]}.git`
  throw new Error(`Not a GitHub repository URL: ${raw}`)
}

// A push can fail for many reasons (auth cancelled, empty repo, network); git
// prints a multi-line wall. Surface just the first meaningful line, clipped, so
// the dialog shows a clean reason instead of a paragraph of git internals.
function cleanDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  const line = msg
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  return (line ?? 'Push failed').slice(0, 200)
}

// status() runs a `git fetch` — a NETWORK subprocess. The renderer polls the
// sync badge (mount, 60s interval, vault:changed), so uncached status meant a
// recurring fetch storm. Serve from a short-lived cache; sync:now (and the
// 5-minute auto-sync) still hit the remote for real.
let statusCache: { value: SyncStatusDto; at: number } | null = null
const STATUS_TTL_MS = 45_000

async function statusDto(ctx: VaultContext): Promise<SyncStatusDto> {
  if (!ctx.git) return { state: 'no-remote', ahead: 0, behind: 0 }
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.value
  try {
    const sync = syncOf(ctx)
    // Local refs only. The badge poller (60s) outran this 45s cache by design,
    // so every poll was a cache miss and every miss was a `git fetch`.
    const [status, remote] = await Promise.all([sync.status({ fetch: false }), sync.remoteUrl()])
    // The URL travels with the status so the backup dialog can show WHICH repo
    // this vault is attached to. "Connected" without a name is a claim; with
    // the repo spelled out it is something the user can verify.
    statusCache = { value: { ...status, ...(remote ? { remote } : {}) }, at: Date.now() }
    return statusCache.value
  } catch {
    return { state: 'error', ahead: 0, behind: 0 }
  }
}

async function performSync(ctx: VaultContext): Promise<SyncStatusDto> {
  statusCache = null // a real sync changes what status() should report
  if (!ctx.git) return { state: 'no-remote', ahead: 0, behind: 0 }
  const sync = syncOf(ctx)
  if (!(await sync.hasRemote())) return { state: 'no-remote', ahead: 0, behind: 0 }
  await sync.commitAll('sync: local changes')
  const pull = await sync.pull()
  let conflictCards = 0
  if (pull.conflicts.length > 0) {
    const resolution = await resolveConflicts(sync, pull.conflicts, ctx.engines[0] ?? null)
    conflictCards = resolution.cards.length
  }
  await sync.push()
  broadcast({ type: 'vault:changed' })
  return { ...(await statusDto(ctx)), conflictCards }
}

export function getSyncStatus(ctx: VaultContext): Promise<SyncStatusDto> {
  return statusDto(ctx)
}

export function registerTeamIpc(ctx: VaultContext): void {
  ipcMain.handle('sync:status', () => statusDto(ctx))

  ipcMain.handle('sync:now', () => performSync(ctx))

  // ↓ click: the librarian narrates the incoming diff in human language.
  ipcMain.handle('sync:brief', async () => {
    if (!ctx.git) return 'No team connected yet.'
    const sync = syncOf(ctx)
    if (!(await sync.hasRemote())) return 'No team connected yet.'
    const diff = await sync.incomingDiff()
    if (!diff.trim()) return 'Nothing new from the team.'
    const engine = ctx.engines[0]
    if (!engine) return `Incoming changes:\n\n${diff}`
    try {
      return await collectResult(engine, {
        prompt: `Summarize these incoming team changes for a teammate in 3 short bullet points, plain language, no git jargon:\n\n${diff}`,
        workdir: engineCwd(ctx.paths),
      })
    } catch {
      return `Incoming changes:\n\n${diff}`
    }
  })

  ipcMain.handle('team:join', async (_e, url: string) => {
    // joining replaces an EMPTY workspace only — never clobber notes.
    try {
      await access(join(ctx.paths.workspace, '.git'))
      throw new Error('This vault already has team history — join from a fresh vault instead.')
    } catch (err) {
      if (err instanceof Error && err.message.includes('team history')) throw err
    }
    await joinTeam(ctx.paths.root, url)
    teamSync = null
    broadcast({ type: 'vault:changed' })
  })

  // One-click GitHub backup (no pre-registered OAuth app needed). Step 1 opens
  // GitHub's create-repo page prefilled private; the browser + bundled git's
  // credential manager handle auth on the first push.
  ipcMain.handle('github:openNew', (_e, name: string) => {
    const suggested = encodeURIComponent(name.trim() || 'engram-vault')
    const url = `https://github.com/new?name=${suggested}&visibility=private`
    // Host is a literal here, but gate every openExternal through the allowlist
    // so no code path can ever hand the OS browser an off-allowlist URL.
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
  })

  // Step 2: point the existing vault repo at the pasted repo and push. Idempotent
  // and retry-safe — a prior push that failed on auth left the remote in place,
  // so we push again rather than trap the user behind an "already connected" wall.
  ipcMain.handle('github:connect', async (_e, url: string): Promise<GithubConnectResultDto> => {
    const sync = syncOf(ctx)
    let normalized: string
    try {
      normalized = normalizeGithubUrl(url)
    } catch (err) {
      return { ok: false, detail: cleanDetail(err) }
    }
    const existing = await sync.remoteUrl()
    // A remote to a *different* repo means this workspace is already backed up
    // elsewhere — refuse rather than silently repoint it.
    if (existing && normalizeGithubUrl(existing) !== normalized) {
      throw new Error('already-connected')
    }
    try {
      if (existing) await sync.push()
      else await sync.createTeam(normalized)
    } catch (err) {
      return { ok: false, detail: cleanDetail(err) }
    }
    startAutoSync(ctx, true)
    broadcast({ type: 'vault:changed' })
    return { ok: true }
  })

  ipcMain.handle('import:run', async (_e, folder: string) => {
    const report = await runImport(ctx.paths, folder, {
      onProgress: (done, total) => broadcast({ type: 'import:progress', done, total }),
    })
    broadcast({ type: 'vault:changed' })
    // Start absorbing the freshly-queued imports in the background.
    void drainAbsorbQueue(ctx)
    return { imported: report.imported }
  })

  ipcMain.handle('absorb:status', async () => {
    const state = await loadAbsorbState(ctx.paths)
    return { pending: state.pending.length, total: state.total }
  })
}

let autoSyncArmed = false
export function startAutoSync(ctx: VaultContext, auto: boolean): void {
  if (!auto || !ctx.git || autoSyncArmed) return
  autoSyncArmed = true
  const tick = async () => {
    try {
      if (await syncOf(ctx).hasRemote()) await performSync(ctx)
    } catch (err) {
      console.error('auto sync failed:', err)
    }
  }
  void tick()
  setInterval(() => void tick(), 15 * 60_000)
}
