import { beforeEach, expect, it, vi } from 'vitest'
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { initVault } from 'core'

const fake = vi.hoisted(() => ({ base: '', handler: undefined as unknown as (event: { sender: { id: number } }) => Promise<boolean>, confirm: vi.fn(), storage: vi.fn(), restart: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: (name: string) => join(fake.base, name), getAppPath: () => join(fake.base, 'app') },
  dialog: { showMessageBox: fake.confirm }, session: { defaultSession: { clearStorageData: fake.storage } },
  ipcMain: { handle: (_name: string, handler: typeof fake.handler) => { fake.handler = handler } },
}))
vi.mock('../src/main/vault.js', () => ({ binaryProvider: () => undefined }))
import { finishAppReset, registerAppReset } from '../src/main/app-reset.js'
import { registerWorkspace } from '../src/main/workspaces.js'

const data = (name: string) => join(fake.base, 'userData', name)
const request = () => fake.handler({ sender: { id: 7 } })
async function vault(name = 'vault') {
  const root = join(fake.base, name)
  await initVault(root, { git: false })
  await registerWorkspace({ name, root, kind: 'personal' })
  return root
}
beforeEach(async () => {
  vi.resetAllMocks()
  await mkdir(resolve('tmp'), { recursive: true })
  fake.base = await mkdtemp(resolve('tmp/app-reset-'))
  await mkdir(join(fake.base, 'userData'))
  fake.confirm.mockResolvedValue({ response: 1 })
  registerAppReset(() => ({ webContents: { id: 7 } }) as never, fake.restart)
})

it('cancels without touching data and rejects a request outside the settings window', async () => {
  const root = await vault()
  await expect(fake.handler({ sender: { id: 8 } })).rejects.toThrow('Settings')
  fake.confirm.mockResolvedValue({ response: 0 })
  expect(await request()).toBe(false)
  await access(root)
  await expect(access(data('reset-request.json'))).rejects.toThrow()
  expect(fake.restart).not.toHaveBeenCalled()
})

it('erases app-owned workspaces and settings only on next boot, preserving sign-ins, runtimes and external files', async () => {
  const first = await vault(), second = await vault('second')
  await writeFile(data('settings.json'), '{"theme":"dark"}')
  await writeFile(join(fake.base, 'original.txt'), 'keep')
  for (const name of ['account-profiles', 'runtimes', 'webview2-profile', 'Network']) {
    await mkdir(data(name)); await writeFile(data(`${name}/keep.txt`), 'keep')
  }
  expect(await request()).toBe(true)
  await access(first)
  await vi.waitFor(() => expect(fake.restart).toHaveBeenCalledOnce())
  expect(fake.confirm).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ defaultId: 0, cancelId: 0, detail: expect.stringContaining('No backup') }))
  expect(await finishAppReset()).toBe(true)
  for (const path of [first, second, data('settings.json'), data('vaults.json'), data('reset-request.json')]) await expect(access(path)).rejects.toThrow()
  for (const name of ['account-profiles', 'runtimes', 'webview2-profile', 'Network']) expect(await readFile(data(`${name}/keep.txt`), 'utf8')).toBe('keep')
  expect(await readFile(join(fake.base, 'original.txt'), 'utf8')).toBe('keep')
  expect(fake.storage).toHaveBeenCalledWith({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] })
  expect(await finishAppReset()).toBe(true)
})

it('refuses mixed workspaces and linked app data before confirmation', async () => {
  const root = await vault()
  await writeFile(join(root, 'outside.txt'), 'keep')
  await expect(request()).rejects.toThrow('outside Engram')
  expect(fake.confirm).not.toHaveBeenCalled()
})

it('revalidates all roots before deletion and never resets an unapproved new workspace', async () => {
  const first = await vault()
  await request()
  const second = await vault('new')
  fake.confirm.mockResolvedValue({ response: 0 })
  expect(await finishAppReset()).toBe(false)
  await access(first); await access(second); await access(data('reset-request.json'))
  fake.confirm.mockResolvedValue({ response: 1 })
  expect(await finishAppReset()).toBe(true)
  await expect(access(data('reset-request.json'))).rejects.toThrow()
  await access(first); await access(second)
})

it('rejects an app-data junction without following it into external data', async () => {
  await vault()
  const external = join(fake.base, 'external')
  await mkdir(external); await writeFile(join(external, 'keep.txt'), 'keep')
  await symlink(external, data('logs'), 'junction')
  await expect(request()).rejects.toThrow('Linked app data')
  expect(await readFile(join(external, 'keep.txt'), 'utf8')).toBe('keep')
  expect(fake.confirm).not.toHaveBeenCalled()
})

it('does not report success or erase settings if the registry disappeared but the approved workspace remains', async () => {
  const root = await vault()
  await request()
  await writeFile(data('vaults.json'), JSON.stringify({ current: null, vaults: [] }))
  await writeFile(data('settings.json'), '{"theme":"dark"}')
  fake.confirm.mockResolvedValue({ response: 0 })
  expect(await finishAppReset()).toBe(false)
  await access(root)
  expect(await readFile(data('settings.json'), 'utf8')).toBe('{"theme":"dark"}')
  expect(fake.storage).not.toHaveBeenCalled()
})
