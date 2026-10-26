import { app } from 'electron'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { TraceVisit } from 'core'
import { firefoxPlaces } from './browser-roots.js'
import { flog } from './flog.js'

interface Db { exec(sql: string): { values: unknown[][] }[]; close(): void }
export interface PlacesBookmark { title: string; url: string; folder: string; folderPath: string[] }

// Firefox holds places.sqlite open while it runs: each profile's file is read
// from a copy, with sql.js. One unreadable profile does not hide the others.
export async function readFirefox<T>(read: (db: Db) => T[]): Promise<T[]> {
  const files = firefoxPlaces()
  if (!files.length) return []
  const tempDir = join(app.getPath('userData'), 'tmp')
  await mkdir(tempDir, { recursive: true })
  const SQL = await (await import('sql.js')).default()
  const found: T[] = []
  for (const file of files) {
    const temp = join(tempDir, `places-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    try {
      await copyFile(file, temp)
      const db = new SQL.Database(await readFile(temp))
      try { found.push(...read(db)) } finally { db.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') flog('firefox-places', error)
    } finally { await rm(temp, { force: true }).catch(() => undefined) }
  }
  return found
}

// Visit times are microseconds since 1970; the visit it came from is the referring one.
export function firefoxVisits(db: Db, sinceMs: number): TraceVisit[] {
  const rows = db.exec(`SELECT p.url, p.title, v.visit_date / 1000, fp.url FROM moz_historyvisits v JOIN moz_places p ON p.id = v.place_id LEFT JOIN moz_historyvisits fv ON fv.id = NULLIF(v.from_visit, 0) LEFT JOIN moz_places fp ON fp.id = fv.place_id WHERE v.visit_date > ${Math.floor(sinceMs * 1000)} AND p.hidden = 0`)
  return ((rows[0]?.values ?? []) as [string, string | null, number, string | null][]).map(([url, title, at, from]) => ({ url, title: title ?? '', at, ...(from ? { from } : {}) }))
}

const TAGS_ROOT = 'tags________'
const MAX_DEPTH = 20

// Bookmarks are rows of type 1 under folders; tags are kept as bookmarks too and are left out.
export function firefoxBookmarks(db: Db): PlacesBookmark[] {
  const rows = (db.exec('SELECT b.id, b.parent, b.type, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk')[0]?.values ?? []) as [number, number, number, string | null, string, string | null][]
  const byId = new Map(rows.map(row => [row[0], row]))
  const trail = (parent: number): { path: string[]; tag: boolean } => {
    const path: string[] = []
    for (let at = byId.get(parent), depth = 0; at && depth < MAX_DEPTH; at = byId.get(at[1]), depth++) {
      if (at[4] === TAGS_ROOT) return { path, tag: true }
      if (at[3] && at[1] !== at[0]) path.unshift(at[3])
    }
    return { path, tag: false }
  }
  return rows.flatMap(([, parent, type, title, , address]) => {
    if (type !== 1 || !address) return []
    let url: URL
    try { url = new URL(address) } catch { return [] }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return []
    const { path, tag } = trail(parent)
    return tag ? [] : [{ title: (title || url.hostname).slice(0, 300), url: url.href, folder: path.join(' / '), folderPath: path }]
  })
}
