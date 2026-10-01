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
import { currentWorkspaceRoot, finishWorkspaceDeletion, registerWorkspace, registerWorkspaceIpc } from '../src/main/workspaces.js'

const registry = () => join(fixture.base, 'userData/vaults.json')
const readRegistry = async () => JSON.parse(await readFile(registry(), 'utf8'))
const remove = (id: string) => fixture.handlers.get('workspace:delete')!(undefined, id)
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
  registerWorkspaceIpc()
})

it('cancels safely, then deletes only after restart and returns the last workspace to onboarding', async () => {
  const first = await vault('first'), second = await vault('second')
  fixture.confirm.mockResolvedValueOnce({ response: 0 })
  expect(await remove(second.id)).toBe(false)
  expect(fixture.trash).not.toHaveBeenCalled()
  expect(fixture.quit).not.toHaveBeenCalled()
  expect(await remove(second.id)).toBe(true)
  expect(fixture.confirm).toHaveBeenLastCalledWith(expect.objectContaining({ defaultId: 0, cancelId: 0, detail: expect.stringContaining(second.root) }))
  expect(fixture.quit).toHaveBeenCalledOnce()
  expect(fixture.trash).not.toHaveBeenCalled()
  expect((await readRegistry()).pendingDelete).toBe(second.id)
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

it('rejects unknown ids, broad folders, mixed folders, and linked vaults', async () => {
  await expect(remove('unknown')).rejects.toThrow('Unknown workspace')
  const broad = await registerWorkspace({ name: 'Home', root: fixture.base, kind: 'personal' })
  await expect(remove(broad.id)).rejects.toThrow('protected app data')
  const mixed = await vault('mixed')
  await writeFile(join(mixed.root, 'keep.txt'), 'unrelated')
  await expect(remove(mixed.id)).rejects.toThrow('outside Engram')
  const linked = await vault('source')
  const alias = join(fixture.base, 'alias')
  await symlink(linked.root, alias, 'junction')
  const aliasInfo = await registerWorkspace({ name: 'Alias', root: alias, kind: 'personal' })
  await expect(remove(aliasInfo.id)).rejects.toThrow('Linked workspace')
  await expect(remove(linked.id)).rejects.toThrow('Another workspace points inside')
  expect(fixture.confirm).not.toHaveBeenCalled()
  expect(fixture.trash).not.toHaveBeenCalled()
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
