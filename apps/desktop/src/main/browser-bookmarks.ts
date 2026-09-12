import { app } from 'electron'
import { readFile, readdir, stat, mkdir, rename, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { browserProfileRoots } from './browser-import.js'

export interface Bookmark { title: string; url: string; folder: string }
const MAX_BYTES = 5_000_000
const MAX_ITEMS = 10_000

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function parseBookmarks(text: string): Bookmark[] {
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Bookmark file is too large')
  const roots = record(record(JSON.parse(text)).roots)
  if (!Object.keys(roots).length) throw new Error('No bookmark folders found')
  const found = new Map<string, Bookmark>()
  let visited = 0
  const visit = (value: unknown, folder: string[], depth: number) => {
    if (++visited > MAX_ITEMS * 3 || depth > 20) throw new Error('Too many bookmarks or nested folders')
    const node = record(value)
    const title = typeof node.name === 'string' ? node.name.slice(0, 300) : ''
    if (node.type === 'url' && typeof node.url === 'string' && node.url.length <= 8192) {
      let url: URL
      try { url = new URL(node.url) } catch { return }
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
      if (!found.has(url.href)) found.set(url.href, { title: title || url.hostname, url: url.href, folder: folder.join(' / ') })
      if (found.size > MAX_ITEMS) throw new Error('Too many bookmarks')
    } else if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child, title ? [...folder, title] : folder, depth + 1)
    }
  }
  for (const root of Object.values(roots)) visit(root, [], 0)
  return [...found.values()]
}

async function profiles() {
  const found: { id: string; name: string; file: string }[] = []
  for (const root of browserProfileRoots()) {
    for (const dir of await readdir(root.userData, { withFileTypes: true }).catch(() => [])) {
      if (!dir.isDirectory() || !/^(Default|Profile \d+)$/.test(dir.name)) continue
      const file = join(root.userData, dir.name, 'Bookmarks')
      if ((await stat(file).catch(() => null))?.isFile()) found.push({ id: `${root.id}:${dir.name}`, name: `${root.name} · ${dir.name}`, file })
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
  // Reuse the same URL validation for persisted data.
  return parseBookmarks(JSON.stringify({ roots: { imported: { children: rows.map((value) => {
    const row = record(value)
    return { name: typeof row.folder === 'string' ? row.folder.slice(0, 2000) : '', children: [{ type: 'url', name: row.title, url: row.url }] }
  }) } } }))
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
  const imported = parseBookmarks(await readLimited(source.file))
  const merged = new Map((await savedBookmarks()).map((row) => [row.url, row]))
  for (const row of imported) merged.set(row.url, row)
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
