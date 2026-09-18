import { app } from 'electron'
import { readFile, readdir, stat, mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { browserProfileRoots } from './browser-import.js'
import { managedBookmarkSources } from './managed-bookmarks.js'

export interface Bookmark { title: string; url: string; folder: string; folderPath?: string[]; sourceId?: string; sourceName?: string }
const MAX_BYTES = 5_000_000
const MAX_ITEMS = 10_000

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function parseBookmarks(text: string): Bookmark[] {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Bookmark file is too large')
  const decoded: unknown = JSON.parse(text)
  const parsed: unknown = typeof decoded === 'string' ? JSON.parse(decoded) : decoded
  const managed = Array.isArray(parsed)
  const roots = managed ? { managed: { name: record(parsed.find(item => typeof record(item).toplevel_name === 'string')).toplevel_name ?? 'Managed bookmarks', children: parsed.filter(item => !record(item).toplevel_name) } } : record(record(parsed).roots)
  if (!Object.keys(roots).length) throw new Error('No bookmark folders found')
  const found = new Map<string, Bookmark>()
  let visited = 0
  const visit = (value: unknown, folder: string[], depth: number) => {
    if (++visited > MAX_ITEMS * 3 || depth > 20) throw new Error('Too many bookmarks or nested folders')
    const node = record(value)
    const title = typeof node.name === 'string' ? node.name.slice(0, 300) : ''
    if ((node.type === 'url' || managed) && typeof node.url === 'string' && node.url.length <= 8192) {
      let url: URL
      try { url = new URL(managed && !/^[a-z][a-z\d+.-]*:/i.test(node.url) ? `https://${node.url}` : node.url) } catch { return }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
      const key = JSON.stringify([folder, url.href])
      if (!found.has(key)) found.set(key, { title: title || url.hostname, url: url.href, folder: folder.join(' / '), folderPath: folder })
      if (found.size > MAX_ITEMS) throw new Error('Too many bookmarks')
    } else if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child, title ? [...folder, title] : folder, depth + 1)
    }
  }
  for (const root of Object.values(roots)) visit(root, [], 0)
  return [...found.values()]
}

async function profiles() {
  const found: { id: string; name: string; file?: string; text?: string }[] = []
  for (const root of browserProfileRoots()) {
    for (const source of await managedBookmarkSources(root.id)) found.push({ ...source, name: `${root.name} · ${source.name}` })
    const state = await readLimited(join(root.userData, 'Local State')).then(text => record(record(JSON.parse(text)).profile).info_cache).catch(() => undefined)
    for (const dir of await readdir(root.userData, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory() || !/^(Default|Profile \d+)$/.test(dir.name)) continue
      const file = join(root.userData, dir.name, 'Bookmarks')
      const profileName = record(record(state)[dir.name]).name
      const label = typeof profileName === 'string' && profileName.trim() ? profileName.slice(0, 100) : dir.name
      if ((await stat(file).catch(() => null))?.isFile()) found.push({ id: `${root.id}:${dir.name}`, name: `${root.name} · ${label}`, file })
    }
  }
  return found
}

export async function bookmarkSources(): Promise<{ id: string; name: string }[]> {
  return (await profiles()).map(({ id, name }) => ({ id, name }))
}

async function readLimited(file: string): Promise<string> {
  if ((await stat(file)).size > MAX_BYTES) throw new Error('Bookmark file is too large')
  return readFile(file, 'utf8')
}

export async function savedBookmarks(): Promise<Bookmark[]> {
  const file = join(app.getPath('userData'), 'bookmarks.json')
  let text: string
  try { text = await readLimited(file) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const rows: unknown = JSON.parse(text)
  if (!Array.isArray(rows)) throw new Error('Saved bookmarks are invalid')
  if (rows.length > MAX_ITEMS) throw new Error('Too many saved bookmarks')
  // Validate old flat imports and newer source-aware records with the same URL rules.
  return rows.flatMap(value => {
    const row = record(value)
    const path = Array.isArray(row.folderPath) ? row.folderPath.filter((part): part is string => typeof part === 'string').slice(0, 20).map(part => part.slice(0, 300)) : typeof row.folder === 'string' && row.folder ? [row.folder.slice(0, 2000)] : []
    const clean = parseBookmarks(JSON.stringify({ roots: { imported: { children: [{ type: 'url', name: row.title, url: row.url }] } } }))[0]
    return clean ? [{ ...clean, folder: path.join(' / '), folderPath: path, ...(typeof row.sourceId === 'string' ? { sourceId: row.sourceId.slice(0, 200) } : {}), ...(typeof row.sourceName === 'string' ? { sourceName: row.sourceName.slice(0, 300) } : {}) }] : []
  })
}

let importQueue: Promise<unknown> = Promise.resolve()
export function importBookmarks(id: string): Promise<Bookmark[]> {
  const next = importQueue.then(() => mergeBookmarks(id))
  importQueue = next.catch(() => undefined)
  return next
}

async function mergeBookmarks(id: string): Promise<Bookmark[]> {
  const source = (await profiles()).find((row) => row.id === id)
  if (!source) throw new Error('Choose an available browser profile')
  const imported = parseBookmarks(source.text ?? await readLimited(source.file!)).map(row => ({ ...row, sourceId: source.id, sourceName: source.name }))
  if (!imported.length) throw new Error('No bookmarks here — this profile is empty. Try another profile or your organization’s managed bookmarks. Only http and https bookmarks are imported.')
  const key = (row: Bookmark) => JSON.stringify([row.sourceId ?? '', row.folderPath ?? [row.folder], row.url])
  const merged = new Map((await savedBookmarks()).map(row => [key(row), row]))
  for (const row of imported) merged.set(key(row), row)
  if (merged.size > MAX_ITEMS) throw new Error('Too many saved bookmarks')
  const folder = app.getPath('userData')
  await mkdir(folder, { recursive: true })
  const pending = join(folder, `bookmarks-${randomUUID()}.json`)
  const text = JSON.stringify([...merged.values()])
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Combined bookmarks are too large')
  try {
    await writeFile(pending, text, 'utf8')
    await rename(pending, join(folder, 'bookmarks.json'))
  } finally { await rm(pending, { force: true }) }
  return [...merged.values()]
}
