import { beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initVault } from 'core'

const fixture = vi.hoisted(() => ({ base: '', handlers: new Map<string, (_event: unknown, id: string) => Promise<boolean>>(), confirm: vi.fn(), trash: vi.fn(), error: vi.fn(), quit: vi.fn(), relaunch: vi.fn() }))
vi.mock('electron', () => ({
  app: { getPath: (name: string) => join(fixture.base, name), getAppPath: () => join(fixture.base, 'app'), quit: fixture.quit, relaunch: fixture.relaunch },
  dialog: { showMessageBox: fixture.confirm, showErrorBox: fixture.error },
  shell: { trashItem: fixture.trash },
  ipcMain: { handle: (name: string, handler: (_event: unknown, id: string) => Promise<boolean>) => fixture.handlers.set(name, handler) },
}))
vi.mock('../src/main/vault.js', () => ({ binaryProvider: () => undefined }))
import * as workspaces from '../src/main/workspaces.js'
import { currentWorkspaceRoot, finishWorkspaceDeletion, registerWorkspace, validatedWorkspaceRoots, workspacesToMerge } from '../src/main/workspaces.js'

const registry = () => join(fixture.base, 'userData/vaults.json')
const readRegistry = async () => JSON.parse(await readFile(registry(), 'utf8'))
const remove = async (id: string) => { await writeFile(registry(), JSON.stringify({ ...await readRegistry(), pendingDelete: id })) }
async function vault(name: string) {
  const root = join(fixture.base, name)
  await initVault(root, { git: false })
  return registerWorkspace({ name, root, kind: 'personal' })
}
beforeEach(async () => {
  vi.resetAllMocks()
  await mkdir(resolve('tmp'), { recursive: true })
  fixture.base = await mkdtemp(resolve('tmp/workspace-delete-'))
  await mkdir(join(fixture.base, 'userData'))
  fixture.confirm.mockResolvedValue({ response: 1 })
  fixture.trash.mockImplementation((root: string) => rename(root, `${root}-recycled`))
  fixture.handlers.clear()
})

it('offers no way to create, switch to, join or delete a workspace', async () => {
  const first = await vault('first'), second = await vault('second')
  expect(Object.keys(workspaces).filter(name => /ipc|create|switch|join|delete(?!.*Deletion)/i.test(name))).toEqual([])
  expect(fixture.handlers.size).toBe(0)
  expect(await currentWorkspaceRoot()).toBe(second.root)
  expect((await readRegistry()).vaults.map((one: { id: string }) => one.id)).toEqual([first.id, second.id])
  expect(fixture.trash).not.toHaveBeenCalled()
  expect(fixture.quit).not.toHaveBeenCalled()
})

it('lists every other workspace for the merge, and says when the open one is a team\'s', async () => {
  const first = await vault('first'), second = await vault('second'), third = await vault('third')
  expect(await workspacesToMerge()).toEqual({ sources: [{ root: first.root, name: 'first' }, { root: second.root, name: 'second' }], shared: false })
  await remove(first.id)
  expect((await workspacesToMerge()).sources).toEqual([{ root: second.root, name: 'second' }])
  const team = await registerWorkspace({ name: 'team', root: join(fixture.base, 'team'), kind: 'team' })
  expect(await workspacesToMerge()).toMatchObject({ shared: true })
  expect((await workspacesToMerge()).sources.map(one => one.root)).not.toContain(team.root)
  expect(third.root).not.toBe(team.root)
})

it('finishes a deletion confirmed before the update, and returns the last workspace to onboarding', async () => {
  const first = await vault('first'), second = await vault('second')
  await remove(second.id)
  expect(fixture.trash).not.toHaveBeenCalled()
  await finishWorkspaceDeletion()
  expect(fixture.trash).toHaveBeenCalledWith(second.root)
  expect(await currentWorkspaceRoot()).toBe(first.root)
  await writeFile(join(fixture.base, 'userData/vault.json'), JSON.stringify({ root: first.root }))
  await remove(first.id)
  await finishWorkspaceDeletion()
  expect(await currentWorkspaceRoot()).toBeNull()
  expect(await readRegistry()).toEqual({ current: null, vaults: [] })
})

it('keeps the registry and reports a failed trash operation instead of pretending deletion succeeded', async () => {
  const one = await vault('one')
  await remove(one.id)
  fixture.trash.mockRejectedValueOnce(new Error('Folder is in use'))
  await finishWorkspaceDeletion()
  expect(await currentWorkspaceRoot()).toBe(one.root)
  expect((await readRegistry()).pendingDelete).toBeUndefined()
  expect(fixture.error).toHaveBeenCalledWith('Workspace deletion did not finish', expect.stringContaining('Folder is in use'))
})

it('never recycles an unknown id, a broad folder, a mixed folder or a linked vault', async () => {
  const kept = await vault('kept')
  await remove('unknown')
  await finishWorkspaceDeletion()
  expect(fixture.error).toHaveBeenLastCalledWith('Workspace deletion did not finish', expect.stringContaining('no longer exists'))
  const broad = await registerWorkspace({ name: 'Home', root: fixture.base, kind: 'personal' })
  await remove(broad.id)
  await finishWorkspaceDeletion()
  expect(fixture.error).toHaveBeenLastCalledWith('Workspace deletion did not finish', expect.stringContaining('protected app data'))
  await expect(validatedWorkspaceRoots()).rejects.toThrow('protected app data')
  await writeFile(registry(), JSON.stringify({ ...await readRegistry(), vaults: (await readRegistry()).vaults.filter((one: { id: string }) => one.id !== broad.id), current: kept.id }))
  const mixed = await vault('mixed')
  await writeFile(join(mixed.root, 'keep.txt'), 'unrelated')
  await remove(mixed.id)
  await finishWorkspaceDeletion()
  expect(fixture.error).toHaveBeenLastCalledWith('Workspace deletion did not finish', expect.stringContaining('outside Engram'))
  const linked = await vault('source')
  const alias = join(fixture.base, 'alias')
  await symlink(linked.root, alias, 'junction')
  const aliasInfo = await registerWorkspace({ name: 'Alias', root: alias, kind: 'personal' })
  await remove(aliasInfo.id)
  await finishWorkspaceDeletion()
  expect(fixture.error).toHaveBeenLastCalledWith('Workspace deletion did not finish', expect.stringContaining('Linked workspace'))
  expect(fixture.trash).not.toHaveBeenCalled()
  expect(await readFile(join(mixed.root, 'keep.txt'), 'utf8')).toBe('unrelated')
})

it('revalidates the path at startup and leaves unexpected new files untouched', async () => {
  const one = await vault('one')
  await remove(one.id)
  await writeFile(join(one.root, 'external.txt'), 'keep')
  await finishWorkspaceDeletion()
  expect(fixture.trash).not.toHaveBeenCalled()
  expect(await currentWorkspaceRoot()).toBe(one.root)
  expect(await readFile(join(one.root, 'external.txt'), 'utf8')).toBe('keep')
})

it('finishes a pending deletion if the folder was already recycled before a crash', async () => {
  const one = await vault('one')
  await remove(one.id)
  await rename(one.root, `${one.root}-already-recycled`)
  await finishWorkspaceDeletion()
  expect(fixture.trash).not.toHaveBeenCalled()
  expect(await currentWorkspaceRoot()).toBeNull()
})
