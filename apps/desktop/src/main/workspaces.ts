import { renameWithRetry } from 'core'
import { app, dialog, shell } from 'electron'
import { randomBytes } from 'node:crypto'
import { lstat, readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

interface WorkspaceInfo {
  id: string
  name: string
  root: string
  kind: 'personal' | 'team'
  createdAt: string
}

interface Registry {
  pendingDelete?: string
  current: string | null
  vaults: WorkspaceInfo[]
}

function registryPath(): string {
  return join(app.getPath('userData'), 'vaults.json')
}

function legacyMarkerPath(): string {
  return join(app.getPath('userData'), 'vault.json')
}

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
  }
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
  }
  return { current: null, vaults: [] }
}

async function saveRegistry(reg: Registry): Promise<void> {
  const pending = `${registryPath()}.${newId()}.tmp`
  await writeFile(pending, JSON.stringify(reg, null, 2))
  await renameWithRetry(pending, registryPath())
}

async function deletionRoot(vault: WorkspaceInfo, reg: Registry): Promise<string | null> {
  if (!isAbsolute(vault.root)) throw new Error('The workspace path must be absolute.')
  const root = resolve(vault.root)
  const contains = (parent: string, child: string) => { const path = relative(parent, child); return !path || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)) }
  const protectedPaths = [parse(root).root, app.getPath('home'), app.getPath('desktop'), app.getPath('documents'), app.getPath('downloads'), app.getPath('userData'), app.getAppPath()]
  if (protectedPaths.some(path => contains(root, resolve(path))) || reg.vaults.some(other => other.id !== vault.id && contains(root, resolve(other.root)))) throw new Error('This folder contains another workspace or protected app data. It cannot be deleted here.')
  const stat = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (!stat) return null
  if (!stat.isDirectory() || stat.isSymbolicLink() || relative(root, await realpath(root))) throw new Error('Linked workspace folders cannot be deleted here.')
  for (const other of reg.vaults.filter(value => value.id !== vault.id)) {
    if (contains(root, await realpath(other.root).catch(() => resolve(other.root)))) throw new Error('Another workspace points inside this folder. It cannot be deleted here.')
  }
  const entries = await readdir(root)
  if (entries.length !== 2 || !entries.includes('workspace') || !entries.includes('private')) throw new Error('This folder contains files outside Engram. Move them elsewhere before deleting the workspace.')
  for (const path of ['workspace', 'private', 'workspace/.engram', 'workspace/notes']) {
    const info = await lstat(join(root, path))
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('This is not a standalone Engram workspace.')
  }
  return root
}

export async function validatedWorkspaceRoots(): Promise<string[]> {
  const reg = await loadRegistry()
  const roots = await Promise.all(reg.vaults.map(vault => deletionRoot(vault, reg)))
  return roots.filter((root): root is string => root !== null)
}

export async function finishWorkspaceDeletion(): Promise<void> {
  const reg = await loadRegistry()
  if (!reg.pendingDelete) return
  const vault = reg.vaults.find(value => value.id === reg.pendingDelete)
  try {
    if (!vault) throw new Error('The workspace no longer exists in the registry.')
    const root = await deletionRoot(vault, reg)
    if (root) await shell.trashItem(root)
    reg.vaults = reg.vaults.filter(value => value.id !== vault.id)
    if (reg.current === vault.id) reg.current = reg.vaults[0]?.id ?? null
    delete reg.pendingDelete
    await saveRegistry(reg)
  } catch (error) {
    delete reg.pendingDelete
    await saveRegistry(reg)
    dialog.showErrorBox('Workspace deletion did not finish', String(error))
  }
}

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

export async function workspacesToMerge(): Promise<{ sources: { root: string; name: string }[]; shared: boolean }> {
  const reg = await loadRegistry()
  const current = reg.vaults.find(vault => vault.id === reg.current)
  if (!current) return { sources: [], shared: false }
  return { sources: reg.vaults.filter(vault => vault.id !== current.id && vault.id !== reg.pendingDelete && resolve(vault.root) !== resolve(current.root)).map(vault => ({ root: vault.root, name: vault.name })), shared: current.kind === 'team' }
}
