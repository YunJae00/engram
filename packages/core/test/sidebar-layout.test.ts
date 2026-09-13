import { expect, it } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { initVault } from '../src/vault.js'
import { changeSidebarLayout, readSidebarLayout } from '../src/sidebar-layout.js'
import { tmpVaultRoot } from './helpers.js'

it('organizes both sections, persists moves, keeps items when deleting folders, and rejects invalid destinations', async () => {
  const paths = await initVault(await tmpVaultRoot('sidebar'), { git: false })
  const ids = { chat: ['one', 'two', 'three'], routine: ['daily', 'weekly'] }
  expect((await readSidebarLayout(paths, ids)).chat.items.map(item => item.id)).toEqual(ids.chat)
  for (const kind of ['chat', 'routine'] as const) {
    const value = await changeSidebarLayout(paths, { kind, change: { action: 'create-folder', name: '  Work  ' } }, ids)
    const folder = value[kind].folders[0]!.id
    await changeSidebarLayout(paths, { kind, change: { action: 'move-item', id: ids[kind][0]!, folder } }, ids)
    await changeSidebarLayout(paths, { kind, change: { action: 'fold-folder', id: folder, collapsed: true } }, ids)
    expect((await readSidebarLayout(paths, ids))[kind].folders[0]).toEqual({ id: folder, name: 'Work', collapsed: true })
    await changeSidebarLayout(paths, { kind, change: { action: 'move-item', id: ids[kind][1]!, folder } }, ids)
    const moved = await changeSidebarLayout(paths, { kind, change: { action: 'move-item', id: ids[kind][1]!, folder, before: ids[kind][0]! } }, ids)
    expect(moved[kind].items.filter(item => item.folder === folder).map(item => item.id)).toEqual([ids[kind][1], ids[kind][0]])
    const removed = await changeSidebarLayout(paths, { kind, change: { action: 'remove-folder', id: folder } }, ids)
    expect(removed[kind].items.every(item => item.folder === null)).toBe(true)
    expect(removed[kind].items).toHaveLength(ids[kind].length)
  }
  const file = join(paths.cache, 'sidebar-layout.json'), before = await readFile(file, 'utf8')
  await expect(changeSidebarLayout(paths, { kind: 'chat', change: { action: 'move-item', id: 'one', folder: 'missing' } }, ids)).rejects.toThrow('folder')
  await expect(changeSidebarLayout(paths, { kind: 'chat', change: { action: 'move-item', id: 'one', folder: null, before: 'daily' } }, ids)).rejects.toThrow('destination')
  expect(await readFile(file, 'utf8')).toBe(before)
  await writeFile(file, '{broken')
  await expect(changeSidebarLayout(paths, { kind: 'chat', change: { action: 'create-folder', name: 'New' } }, ids)).rejects.toThrow('not been changed')
  expect(await readFile(file, 'utf8')).toBe('{broken')
})

it('serializes concurrent changes, orders folders and reconciles added and removed items', async () => {
  const paths = await initVault(await tmpVaultRoot('sidebar-concurrent'), { git: false })
  const ids = { chat: ['a', 'b'], routine: [] }
  await Promise.all(['First', 'Second'].map(name => changeSidebarLayout(paths, { kind: 'chat', change: { action: 'create-folder', name } }, ids)))
  const initial = await readSidebarLayout(paths, ids)
  const [first, second] = initial.chat.folders
  const moved = await changeSidebarLayout(paths, { kind: 'chat', change: { action: 'move-folder', id: second!.id, before: first!.id } }, ids)
  expect(moved.chat.folders.map(folder => folder.name)).toEqual(['Second', 'First'])
  expect((await readSidebarLayout(paths, { chat: ['b', 'c'], routine: [] })).chat.items.map(item => item.id)).toEqual(['b', 'c'])
})
