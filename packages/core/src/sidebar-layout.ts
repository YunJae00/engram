import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { VaultPaths } from './vault.js'
import { renameWithRetry } from './rename-with-retry.js'

const id = z.string().min(1).max(128).regex(/^[\w-]+$/)
const name = z.string().trim().min(1).max(80).refine(value => [...value].every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127))
const folder = z.object({ id, name, collapsed: z.boolean().optional() })
const group = z.object({ folders: z.array(folder).max(100), items: z.array(z.object({ id, folder: id.nullable() })).max(10000) })
const layout = z.object({ chat: group, routine: group })
export type SidebarLayout = z.infer<typeof layout>
export type SidebarKind = keyof SidebarLayout
export type SidebarIds = Record<SidebarKind, string[]>
const action = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create-folder'), name }).strict(),
  z.object({ action: z.literal('rename-folder'), id, name }).strict(),
  z.object({ action: z.literal('remove-folder'), id }).strict(),
  z.object({ action: z.literal('fold-folder'), id, collapsed: z.boolean() }).strict(),
  z.object({ action: z.literal('move-folder'), id, before: id.optional() }).strict(),
  z.object({ action: z.literal('move-item'), id, folder: id.nullable(), before: id.optional() }).strict(),
])
export const sidebarChange = z.object({ kind: z.enum(['chat', 'routine']), change: action }).strict()
export type SidebarChange = z.infer<typeof sidebarChange>

function reconcile(value: SidebarLayout, ids: SidebarIds): SidebarLayout {
  for (const kind of ['chat', 'routine'] as const) {
    const current = value[kind]
    const folders = new Set(current.folders.map(one => one.id))
    const valid = new Set(ids[kind]), seen = new Set<string>()
    current.folders = current.folders.filter((one, i, all) => all.findIndex(other => other.id === one.id) === i)
    current.items = current.items.filter(one => { if (!valid.has(one.id) || seen.has(one.id)) return false; seen.add(one.id); return true })
    for (const one of current.items) if (one.folder && !folders.has(one.folder)) one.folder = null
    current.items.push(...ids[kind].filter(key => !seen.has(key)).map(key => ({ id: key, folder: null })))
  }
  return value
}

export async function readSidebarLayout(paths: VaultPaths, ids: SidebarIds): Promise<SidebarLayout> {
  let saved: SidebarLayout = { chat: { folders: [], items: [] }, routine: { folders: [], items: [] } }
  try { saved = layout.parse(JSON.parse(await readFile(join(paths.cache, 'sidebar-layout.json'), 'utf8'))) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The sidebar layout could not be read. Your saved layout has not been changed.') }
  return reconcile(saved, ids)
}

const writes = new Map<string, Promise<unknown>>()
export async function changeSidebarLayout(paths: VaultPaths, input: SidebarChange, ids: SidebarIds): Promise<SidebarLayout> {
  const request = sidebarChange.parse(input)
  const file = join(paths.cache, 'sidebar-layout.json')
  const next = (writes.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const value = await readSidebarLayout(paths, ids)
    const current = value[request.kind], change = request.change
    const namedFolder = 'id' in change ? current.folders.find(one => one.id === change.id) : undefined
    if (change.action === 'create-folder') {
      if (current.folders.length >= 100) throw new Error('This section already has 100 folders.')
      current.folders.push({ id: randomUUID(), name: change.name })
    } else if (change.action === 'move-item') {
      const item = current.items.find(one => one.id === change.id)
      if (!item) throw new Error('This item no longer exists.')
      if (change.folder && !current.folders.some(one => one.id === change.folder)) throw new Error('This folder no longer exists.')
      if (change.before && !current.items.some(one => one.id === change.before && one.folder === change.folder)) throw new Error('The destination changed. Try again.')
      if (change.before !== change.id) {
        current.items = current.items.filter(one => one.id !== change.id)
        item.folder = change.folder
        const at = change.before ? current.items.findIndex(one => one.id === change.before) : current.items.length
        current.items.splice(at, 0, item)
      }
    } else {
      if (!namedFolder) throw new Error('This folder no longer exists.')
      if (change.action === 'rename-folder') namedFolder.name = change.name
      if (change.action === 'fold-folder') namedFolder.collapsed = change.collapsed
      if (change.action === 'remove-folder') {
        current.folders = current.folders.filter(one => one.id !== change.id)
        for (const item of current.items) if (item.folder === change.id) item.folder = null
      }
      if (change.action === 'move-folder' && change.before !== change.id) {
        if (change.before && !current.folders.some(one => one.id === change.before)) throw new Error('The destination changed. Try again.')
        current.folders = current.folders.filter(one => one.id !== change.id)
        current.folders.splice(change.before ? current.folders.findIndex(one => one.id === change.before) : current.folders.length, 0, namedFolder)
      }
    }
    await mkdir(paths.cache, { recursive: true })
    const temporary = `${file}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(layout.parse(value)))
    await renameWithRetry(temporary, file)
    return value
  })
  writes.set(file, next)
  try { return await next } finally { if (writes.get(file) === next) writes.delete(file) }
}
