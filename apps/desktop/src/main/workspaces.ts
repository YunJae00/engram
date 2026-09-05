import { initVault, joinTeam } from 'core'
import { app, ipcMain } from 'electron'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { WorkspaceInfoDto } from '../shared/types.js'
import { binaryProvider } from './vault.js'

// App-level registry of vaults ("workspaces"): personal or team roots the user
// can switch between. Lives in Electron userData as vaults.json and is the
// single source of truth for which vault boots. Registered BEFORE any vault is
// open so the switcher and onboarding both work.
interface WorkspaceInfo {
  id: string
  name: string
  root: string
  kind: 'personal' | 'team'
  createdAt: string
}

interface Registry {
  // current = the id of the active workspace (null = none registered yet).
  current: string | null
  vaults: WorkspaceInfo[]
}

function registryPath(): string {
  return join(app.getPath('userData'), 'vaults.json')
}

// Legacy single-vault marker from older versions ({ root: string }).
function legacyMarkerPath(): string {
  return join(app.getPath('userData'), 'vault.json')
}

// Short random slug for a workspace id (crypto randomBytes hex 6).
function newId(): string {
  return randomBytes(6).toString('hex')
}

async function loadRegistry(): Promise<Registry> {
  try {
    const registry = JSON.parse(await readFile(registryPath(), 'utf8')) as Registry
    let changed = false
    for (const vault of registry.vaults) {
      if (vault.kind !== 'personal' || vault.name !== 'Personal') continue
      vault.name = 'Engram'
      changed = true
    }
    if (changed) {
      await saveRegistry(registry)
    }
    return registry
  } catch {
    // vaults.json missing/unreadable — fall through to legacy migration.
  }
  // Adopt an older vault.json root as the first Engram workspace
  // and persist vaults.json as the new single source of truth.
  try {
    const legacy = JSON.parse(await readFile(legacyMarkerPath(), 'utf8')) as { root?: string }
    if (legacy.root) {
      const entry: WorkspaceInfo = {
        id: newId(),
        name: 'Engram',
        root: resolve(legacy.root),
        kind: 'personal',
        createdAt: new Date().toISOString(),
      }
      const reg: Registry = { current: entry.id, vaults: [entry] }
      await saveRegistry(reg)
      return reg
    }
  } catch {
    // no legacy file either — a fresh install.
  }
  return { current: null, vaults: [] }
}

async function saveRegistry(reg: Registry): Promise<void> {
  await writeFile(registryPath(), JSON.stringify(reg, null, 2))
}

// Adds a workspace if its (resolved) root is not already registered, sets it
// current, and returns the entry (existing or new).
export async function registerWorkspace(input: {
  name: string
  root: string
  kind: 'personal' | 'team'
}): Promise<WorkspaceInfo> {
  const reg = await loadRegistry()
  const resolved = resolve(input.root)
  const existing = reg.vaults.find((v) => resolve(v.root) === resolved)
  if (existing) {
    reg.current = existing.id
    await saveRegistry(reg)
    return existing
  }
  const entry: WorkspaceInfo = {
    id: newId(),
    name: input.name,
    root: resolved,
    kind: input.kind,
    createdAt: new Date().toISOString(),
  }
  reg.vaults.push(entry)
  reg.current = entry.id
  await saveRegistry(reg)
  return entry
}

export async function currentWorkspaceRoot(): Promise<string | null> {
  const reg = await loadRegistry()
  if (!reg.current) return null
  return reg.vaults.find((v) => v.id === reg.current)?.root ?? null
}

function toDto(v: WorkspaceInfo): WorkspaceInfoDto {
  return { id: v.id, name: v.name, root: v.root, kind: v.kind }
}

// Filesystem-safe slug for a new vault directory name.
function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'workspace'
}

// New vault dir under ~/EngramVaults/<slug>, suffixed -2, -3 … to stay unique.
// (Pre-rename vaults keep living wherever the registry points — full paths.)
function newVaultDir(name: string): string {
  const base = join(app.getPath('home'), 'EngramVaults')
  const slug = slugify(name)
  let candidate = join(base, slug)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(base, `${slug}-${n}`)
    n += 1
  }
  return candidate
}

function gitEnabled(): boolean {
  return process.env['ENGRAM_NO_GIT'] !== '1'
}

// ipcMain handlers. Must be registered in registerBaseIpc() so the switcher and
// onboarding work before any vault is booted.
export function registerWorkspaceIpc(): void {
  ipcMain.handle('workspace:list', async () => {
    const reg = await loadRegistry()
    return { current: reg.current, vaults: reg.vaults.map(toDto) }
  })

  ipcMain.handle('workspace:create', async (_e, payload: { name: string }) => {
    const root = newVaultDir(payload.name)
    await initVault(root, { git: gitEnabled(), provider: binaryProvider() })
    const info = await registerWorkspace({ name: payload.name, root, kind: 'personal' })
    // Relaunch into the new vault. Return value is moot (the app dies).
    app.relaunch()
    app.exit(0)
    return toDto(info)
  })

  ipcMain.handle('workspace:join', async (_e, payload: { name: string; url: string }) => {
    const root = newVaultDir(payload.name)
    await joinTeam(root, payload.url, binaryProvider())
    // joinTeam already lays out the vault; initVault is an idempotent ensure.
    await initVault(root, { git: gitEnabled(), provider: binaryProvider() })
    const info = await registerWorkspace({ name: payload.name, root, kind: 'team' })
    app.relaunch()
    app.exit(0)
    return toDto(info)
  })

  ipcMain.handle('workspace:switch', async (_e, id: string) => {
    const reg = await loadRegistry()
    if (!reg.vaults.some((v) => v.id === id)) throw new Error('unknown workspace')
    reg.current = id
    await saveRegistry(reg)
    app.relaunch()
    app.exit(0)
  })

}
