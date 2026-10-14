import { beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const fake = vi.hoisted(() => ({ picker: vi.fn(), save: vi.fn(), window: { show: vi.fn(), focus: vi.fn(), isDestroyed: () => false } }))
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => fake.window }, dialog: { showOpenDialog: fake.picker } }))
vi.mock('../src/main/chat-attachments.js', () => ({ saveChatAttachment: fake.save }))
import { pickQuickFiles, quickFileDialogOpen } from '../src/main/quick-files.js'

const sender = { id: 17, getURL: () => 'file:///app/index.html#quick' } as never
beforeEach(() => { vi.resetAllMocks(); fake.picker.mockResolvedValue({ canceled: true, filePaths: [] }) })

it('keeps the popup alive during a cancellable picker and refuses overlapping pickers', async () => {
  let finish!: (result: { canceled: boolean; filePaths: string[] }) => void
  fake.picker.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const pending = pickQuickFiles(sender, {} as never, 0)
  expect(quickFileDialogOpen(17)).toBe(true)
  await expect(pickQuickFiles(sender, {} as never, 0)).rejects.toThrow('already open')
  finish({ canceled: true, filePaths: [] })
  expect(await pending).toEqual([])
  expect(quickFileDialogOpen(17)).toBe(false)
  expect(fake.window.focus).toHaveBeenCalledOnce()
})

it('validates the sender and file count before opening a dialog', async () => {
  await expect(pickQuickFiles({ id: 18, getURL: () => 'https://example.com' } as never, {} as never, 0)).rejects.toThrow('quick chat')
  for (const count of [-1, 8, 1.5, '0']) await expect(pickQuickFiles(sender, {} as never, count)).rejects.toThrow('up to 8')
  expect(fake.picker).not.toHaveBeenCalled()
})

it('saves only the bytes of a selected regular file, not a linked path supplied by a renderer', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const folder = await mkdtemp(resolve('tmp/quick-files-')), path = join(folder, 'example.txt')
  await writeFile(path, 'Selected file')
  fake.picker.mockResolvedValue({ canceled: false, filePaths: [path] })
  fake.save.mockImplementation((_paths, name, data) => ({ id: name, size: data.byteLength }))
  expect(await pickQuickFiles(sender, {} as never, 0)).toEqual([{ id: 'example.txt', size: 13 }])
  expect(fake.save.mock.calls[0][2].toString()).toBe('Selected file')
})

it('rejects too many chosen files without saving any data', async () => {
  fake.picker.mockResolvedValue({ canceled: false, filePaths: ['one', 'two'] })
  await expect(pickQuickFiles(sender, {} as never, 7)).rejects.toThrow('up to 8')
  expect(fake.save).not.toHaveBeenCalled()
  expect(quickFileDialogOpen(17)).toBe(false)
})
