import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { vaultPaths } from '../../../packages/core/src/vault.js'

const state = vi.hoisted(() => ({ stopped: false, confirm: vi.fn(), getPath: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: state.getPath }, dialog: { showMessageBox: state.confirm }, ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }, shell: { showItemInFolder: vi.fn() } }))
vi.mock('../src/main/desktop-control.js', () => ({ assertDesktopTurnNotStopped: () => { if (state.stopped) throw new Error('Stopped for this turn') } }))
import { cometFileTools } from '../src/main/file-work.js'

let root: string
beforeEach(async () => {
  await mkdir('tmp', { recursive: true })
  root = await mkdtemp(resolve('tmp/file-host-'))
  await mkdir(join(root, 'private'))
  state.stopped = false
  state.confirm.mockReset().mockResolvedValue({ response: 1 })
  state.getPath.mockReset().mockImplementation(() => root)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('does not expose the private vault even through a model-selected file path', async () => {
  const path = join(root, 'private', 'note.txt')
  await writeFile(path, 'private')
  const tool = cometFileTools(vaultPaths(root), 'lane').find((tool) => tool.name === 'file_read')!
  await expect(tool.run({ path }, { task: 'Read a file.' })).rejects.toThrow('Private vault')
  expect(state.confirm).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('checks the canonical target after approval so an alias cannot expose private files', async () => {
  const target = join(root, 'private', 'note.txt')
  const path = join(root, 'alias.txt')
  await writeFile(target, 'private')
  await symlink(target, path)
  const tool = cometFileTools(vaultPaths(root), 'lane').find((tool) => tool.name === 'file_read')!
  await expect(tool.run({ path }, { task: 'Read a file.' })).rejects.toThrow('Private vault')
  expect(state.confirm).toHaveBeenCalledOnce()
})

it('requires an exact-path native consent and honors Stop during the consent dialog', async () => {
  const path = join(root, 'input.json')
  await writeFile(path, '{"safe":true}')
  const tool = cometFileTools(vaultPaths(root), 'lane').find((tool) => tool.name === 'file_read')!
  state.confirm.mockImplementation(async () => { state.stopped = true; return { response: 1 } })
  await expect(tool.run({ path }, { task: 'Read a file.' })).rejects.toThrow('Stopped')
  expect(state.confirm.mock.calls[0]![0].detail).toContain(path)
  expect(state.confirm.mock.calls[0]![0].defaultId).toBe(0)
})

it('reads explicitly attached copies without asking to approve their contents again', async () => {
  const path = join(root, 'input.json')
  await writeFile(path, '{"safe":true}')
  const tool = cometFileTools(vaultPaths(root), 'lane', [path]).find((tool) => tool.name === 'file_read')!
  expect(JSON.parse(await tool.run({ path }, { task: 'Read the attached file.' })).content).toBe('{"safe":true}')
  expect(state.confirm).not.toHaveBeenCalled()
})

it('does not bypass a cancelled desktop turn by switching to file creation', async () => {
  state.stopped = true
  const tools = cometFileTools(vaultPaths(root), 'lane')
  for (const name of ['file_create_copy', 'file_create_workbook']) {
    await expect(tools.find((tool) => tool.name === name)!.run({}, { task: 'Keep working.' })).rejects.toThrow('Stopped')
  }
  expect(await readdir(root)).toEqual(['private'])
})

it('uses operating-system document folders for discovery without approving or reading content', async () => {
  await writeFile(join(root, 'budget.pdf'), 'content stays local')
  const tool = cometFileTools(vaultPaths(root), 'lane').find(tool => tool.name === 'find_files')!
  const result = JSON.parse(await tool.run({ query: 'budget' }, { task: 'Find the budget file' }))
  expect(result.matches[0].path).toBe(join(root, 'budget.pdf'))
  expect(state.getPath.mock.calls.map(call => call[0])).toEqual(['documents', 'desktop', 'downloads'])
  expect(state.confirm).not.toHaveBeenCalled()
  expect(JSON.stringify(result)).not.toContain('content stays local')
})
