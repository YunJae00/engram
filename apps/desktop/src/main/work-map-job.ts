import { app, ipcMain } from 'electron'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  applyLabels,
  buildWorkMap,
  collectResult,
  engineBackoff,
  engineCwd,
  labelPrompt,
  learnedPlaces,
  placeNote,
  placeNoteId,
  readNote,
  readWorkMap,
  workShortcuts,
  writeNote,
  writeWorkMap,
  type TraceVisit,
  type WorkMap,
} from 'core'
import { allBookmarks } from './browser-bookmarks.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { loadSettings } from './settings.js'
import type { VaultContext } from './vault.js'
import { historyCandidates } from './web-trail.js'

// The work map, kept the way the librarian keeps the vault: in the background,
// once a day, only when the person turned it on. It reads the browser's own
// history and bookmarks on this computer, names the places with one short
// model call, and writes a note per work place.

const WINDOW_MS = 90 * 86_400_000
const STALE_MS = 86_400_000
const CHECK_MS = 60 * 60_000
const FIRST_CHECK_MS = 90_000
const LABEL_TIMEOUT_MS = 120_000
const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1)

// Browsers hold History locked while running: read a copy, with sql.js.
async function readVisits(sinceMs: number, signal: AbortSignal): Promise<TraceVisit[]> {
  const visits: TraceVisit[] = []
  const tempDir = join(app.getPath('userData'), 'tmp')
  await mkdir(tempDir, { recursive: true })
  const SQL = await (await import('sql.js')).default()
  for (const file of historyCandidates()) {
    signal.throwIfAborted()
    const temp = join(tempDir, `work-map-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
    try {
      await copyFile(file, temp)
      signal.throwIfAborted()
      const db = new SQL.Database(await readFile(temp))
      const since = Math.floor((sinceMs - WEBKIT_EPOCH_MS) * 1_000)
      // The visit it came from: a link in the same tab, or the tab that opened it (newer browsers).
      const columns = new Set((db.exec('PRAGMA table_info(visits)')[0]?.values ?? []).map(column => String(column[1])))
      const origin = ['from_visit', 'opener_visit'].filter(name => columns.has(name)).map(name => `NULLIF(v.${name}, 0)`)
      const via = origin.length ? `LEFT JOIN visits fv ON fv.id = ${origin.length > 1 ? `COALESCE(${origin.join(', ')})` : origin[0]} LEFT JOIN urls fu ON fu.id = fv.url` : ''
      const rows = db.exec(`SELECT u.url, u.title, v.visit_time / 1000, ${via ? 'fu.url' : 'NULL'} FROM visits v JOIN urls u ON u.id = v.url ${via} WHERE v.visit_time > ${since} AND u.hidden = 0`)
      db.close()
      for (const [url, title, at, from] of (rows[0]?.values ?? []) as [string, string | null, number, string | null][]) visits.push({ url, title: title ?? '', at: WEBKIT_EPOCH_MS + at, ...(from ? { from } : {}) })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') flog('work-map', error)
    } finally {
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }
  return visits
}

let current: VaultContext | null = null
let running: Promise<WorkMap | null> | null = null
let controller: AbortController | null = null

export function refreshWorkMap(ctx: VaultContext): Promise<WorkMap | null> {
  if (running) return running
  const abort = new AbortController()
  controller = abort
  const allowed = async () => !abort.signal.aborted && (await loadSettings()).workMap && !abort.signal.aborted
  running ??= (async () => {
    try {
      // Isolated app fixtures must not inspect the real browser, even via IPC.
      if (!(await allowed()) || process.env['ENGRAM_USERDATA']) return null
      const now = new Date()
      const [visits, bookmarks, previous] = await Promise.all([readVisits(now.getTime() - WINDOW_MS, abort.signal), allBookmarks(), readWorkMap(ctx.paths).catch(() => null)])
      if (!(await allowed())) return null
      let map = buildWorkMap(visits, bookmarks, now)
      // A day the labelling call cannot run keeps yesterday's names.
      const known = new Map((previous?.places ?? []).map((place) => [place.host, place]))
      map = { ...map, places: map.places.map((place) => ({ ...place, ...(known.get(place.host)?.purpose ? { purpose: known.get(place.host)!.purpose } : {}), ...(known.get(place.host)?.work !== undefined ? { work: known.get(place.host)!.work } : {}) })) }
      const engine = ctx.engines[0]
      if (engine && map.places.length && engineBackoff.blockedMs() === 0) {
        try {
          map = applyLabels(map, await collectResult(engine, { prompt: labelPrompt(map), workdir: engineCwd(ctx.paths), disallowTools: true, timeoutMs: LABEL_TIMEOUT_MS, modelHint: 'fast', signal: abort.signal }))
        } catch (error) { flog('work-map', `labelling failed - ${error instanceof Error ? error.message : String(error)}`) }
      }
      if (!(await allowed())) return null
      await writeWorkMap(ctx.paths, map, abort.signal)
      for (const place of map.places.filter((one) => one.work === true)) {
        const existing = await readNote(ctx.paths, placeNoteId(place.host)).catch(() => null)
        if (!(await allowed())) return null
        await writeNote(ctx.paths, placeNote(place, now, existing))
      }
      flog('work-map', `mapped ${map.places.length} places from ${visits.length} visits and ${bookmarks.length} bookmarks`)
      broadcast({ type: 'vault:changed' })
      return map
    } catch (error) {
      if (abort.signal.aborted) return null
      throw error
    } finally { running = null; if (controller === abort) controller = null }
  })()
  return running
}

async function refreshIfStale(): Promise<void> {
  if (!current || !(await loadSettings()).workMap) return
  const map = await readWorkMap(current.paths).catch(() => null)
  if (map && Date.now() - Date.parse(map.builtAt) < STALE_MS) return
  await refreshWorkMap(current)
}

// What each comet turn carries: the short list of work places, or nothing.
export async function workMapShortcuts(ctx: VaultContext): Promise<string> {
  if (!(await loadSettings()).workMap) return ''
  return workShortcuts(await readWorkMap(ctx.paths).catch(() => null), 40, await learnedPlaces(ctx.paths).catch(() => new Map<string, string>()))
}

let timer: NodeJS.Timeout | null = null
export function startWorkMap(ctx: VaultContext): void {
  current = ctx
  if (timer) return
  // A probe or test profile never reads the person's real browser.
  if (process.env['ENGRAM_USERDATA']) return
  const check = () => void refreshIfStale().catch((error) => flog('work-map', error))
  setTimeout(check, FIRST_CHECK_MS).unref()
  timer = setInterval(check, CHECK_MS)
  timer.unref()
}

// Turned on in Settings or at onboarding: map now rather than within the hour.
export function workMapSettingChanged(on: boolean): void {
  if (!on) { controller?.abort(); return }
  if (on && current && !process.env['ENGRAM_USERDATA']) void refreshWorkMap(current).catch((error) => flog('work-map', error))
}

export function registerWorkMapIpc(ctx: VaultContext): void {
  ipcMain.handle('workMap:status', async () => {
    const map = await readWorkMap(ctx.paths).catch(() => null)
    return { builtAt: map?.builtAt ?? null, places: map?.places.filter((place) => place.work !== false).length ?? 0 }
  })
  ipcMain.handle('workMap:refresh', async () => {
    const map = await refreshWorkMap(ctx)
    return { builtAt: map?.builtAt ?? null, places: map?.places.filter((place) => place.work !== false).length ?? 0 }
  })
}
