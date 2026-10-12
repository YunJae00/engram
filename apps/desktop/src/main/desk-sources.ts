import { app, shell } from 'electron'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, win32 } from 'node:path'
import { promisify } from 'node:util'
import { appsNote, DESK_NOTES, DESK_WINDOW_DAYS, downloadsNote, filesNote, parseUserAssist, readNote, writeNote, type AppUse, type Download, type Note, type RecentFile } from 'core'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { loadSettings } from './settings.js'
import type { VaultContext } from './vault.js'
import { historyCandidates } from './web-trail.js'

// The desk half of the work map: the files, apps and downloads this computer
// already records, each read only while the person allows that source.
// Names and counts only; no file is opened.

const STALE_MS = 86_400_000
const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1)
const run = promisify(execFile)

// Windows keeps a shortcut per recently opened file; its target is the file.
// Engram's own workspace is its record, not the person's work.
async function readRecentFiles(sinceMs: number, workspace: string): Promise<RecentFile[]> {
  const own = (path: string) => !relative(workspace, path).startsWith('..') && !isAbsolute(relative(workspace, path))
  if (process.platform === 'darwin') {
    const found: RecentFile[] = []
    for (const folder of ['Desktop', 'Documents', 'Downloads']) {
      for (const name of await readdir(join(homedir(), folder)).catch(() => [] as string[])) {
        if (name.startsWith('.')) continue
        const path = join(homedir(), folder, name)
        const info = await stat(path).catch(() => null)
        if (info?.isFile() && info.mtimeMs >= sinceMs && !own(path)) found.push({ path, at: info.mtimeMs })
      }
    }
    return found
  }
  if (process.platform !== 'win32') return []
  const recent = join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Recent')
  const found: RecentFile[] = []
  for (const name of await readdir(recent).catch(() => [] as string[])) {
    if (!name.toLowerCase().endsWith('.lnk')) continue
    const info = await stat(join(recent, name)).catch(() => null)
    if (!info || info.mtimeMs < sinceMs) continue
    try {
      const target = shell.readShortcutLink(join(recent, name)).target
      // Folders and links without a file type say where, not what.
      if (target && extname(target) && !own(target)) found.push({ path: target, at: info.mtimeMs })
    } catch { continue }
  }
  return found
}

async function readUsedApps(): Promise<AppUse[]> {
  if (process.platform !== 'win32') return []
  const { stdout } = await run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\UserAssist', '/s'], { encoding: 'latin1', maxBuffer: 8 * 1024 * 1024, windowsHide: true })
  return parseUserAssist(stdout)
}

// Browsers hold History locked while running: read a copy, with sql.js.
async function readDownloads(sinceMs: number): Promise<Download[]> {
  const found: Download[] = []
  const tempDir = join(app.getPath('userData'), 'tmp')
  await mkdir(tempDir, { recursive: true })
  const SQL = await (await import('sql.js')).default()
  for (const file of historyCandidates()) {
    const temp = join(tempDir, `desk-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    try {
      await copyFile(file, temp)
      const db = new SQL.Database(await readFile(temp))
      const columns = new Set((db.exec('PRAGMA table_info(downloads)')[0]?.values ?? []).map(column => String(column[1])))
      const from = ['site_url', 'referrer', 'tab_url'].filter(name => columns.has(name)).map(name => `NULLIF(${name}, '')`)
      const since = Math.floor((sinceMs - WEBKIT_EPOCH_MS) * 1_000)
      const origin = from.length > 1 ? `COALESCE(${from.join(', ')})` : from[0]
      const rows = origin ? db.exec(`SELECT target_path, start_time / 1000, ${origin} FROM downloads WHERE start_time > ${since}`) : []
      db.close()
      for (const [target, at, origin] of (rows[0]?.values ?? []) as [string, number, string | null][]) {
        try { if (target && origin) found.push({ file: /^(?:[a-z]:[\\/]|\\\\)/i.test(target) ? win32.basename(target) : basename(target), host: new URL(origin).hostname, at: WEBKIT_EPOCH_MS + at }) } catch { continue }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') flog('desk-map', error)
    } finally { await rm(temp, { force: true }).catch(() => undefined) }
  }
  return found
}

type Source = { id: string; setting: 'workFiles' | 'workApps' | 'workMap'; build(now: Date, existing: Note | null): Promise<Note | null> }

// Writes each allowed source's note when it is missing or a day old; `force`
// rewrites it at once, as when the person has just allowed it.
export async function refreshDeskNotes(ctx: VaultContext, force = false): Promise<void> {
  if (process.env['ENGRAM_USERDATA']) return
  const settings = await loadSettings()
  const now = new Date(), since = now.getTime() - DESK_WINDOW_DAYS * 86_400_000
  const sources: Source[] = [
    { id: DESK_NOTES.files, setting: 'workFiles', build: async (at, existing) => filesNote(await readRecentFiles(since, ctx.paths.root), at, existing) },
    { id: DESK_NOTES.apps, setting: 'workApps', build: async (at, existing) => appsNote(await readUsedApps(), at, existing) },
    { id: DESK_NOTES.downloads, setting: 'workMap', build: async (at, existing) => downloadsNote(await readDownloads(since), at, existing) },
  ]
  let wrote = false
  for (const source of sources) {
    if (!settings[source.setting]) continue
    try {
      const existing = await readNote(ctx.paths, source.id).catch(() => null)
      if (!force && existing && now.getTime() - Date.parse(existing.front.updated) < STALE_MS) continue
      const note = await source.build(now, existing)
      // The person may have turned the source off while it was being read.
      if (!note || !(await loadSettings())[source.setting]) continue
      await writeNote(ctx.paths, note)
      await ctx.store.applyFile('add', join(ctx.paths.notes, `${note.front.id}.md`))
      wrote = true
    } catch (error) { flog('desk-map', `${source.id}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (wrote) broadcast({ type: 'vault:changed' })
}

// The notes a source the person has not allowed must not feed into filing.
export async function withheldDeskNotes(): Promise<string[]> {
  const settings = await loadSettings()
  return [...(settings.workFiles ? [] : [DESK_NOTES.files]), ...(settings.workApps ? [] : [DESK_NOTES.apps]), ...(settings.workMap ? [] : [DESK_NOTES.downloads])]
}
