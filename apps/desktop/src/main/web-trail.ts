import { app } from 'electron'
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { flog } from './flog.js'

// The web trail — browser history as a capture source. In the webmail/groupware era much of an office day never touches a
// file; the page TITLES in the browser's own local history are the only
// on-device record of what it was about. Titles and hosts only — full URLs
// carry tokens and query noise, so they stay behind.
//
// Mechanics: Chrome/Edge keep History as SQLite and hold it LOCKED while
// running, so the file is copied to a temp path first and parsed there with
// sql.js (wasm — no native ABI to fight electron over). Timestamps are WebKit
// epoch (1601-01-01, microseconds).

export interface WebVisit {
  title: string
  host: string
  at: number
}

const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1)

function historyCandidates(): string[] {
  if (process.platform === 'darwin') {
    const support = join(homedir(), 'Library', 'Application Support')
    return [
      join(support, 'Google', 'Chrome', 'Default', 'History'),
      join(support, 'Microsoft Edge', 'Default', 'History'),
      join(support, 'BraveSoftware', 'Brave-Browser', 'Default', 'History'),
      join(support, 'Arc', 'User Data', 'Default', 'History'),
    ]
  }
  if (process.platform === 'linux') {
    const config = process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config')
    return [
      join(config, 'google-chrome', 'Default', 'History'),
      join(config, 'chromium', 'Default', 'History'),
      join(config, 'microsoft-edge', 'Default', 'History'),
    ]
  }
  const local = process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local')
  return [
    join(local, 'Google', 'Chrome', 'User Data', 'Default', 'History'),
    join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'History'),
  ]
}

const DENY_TITLE = /password|비밀번호|로그인|login|sign in|인증|otp|working\.\.\./i
const DENY_HOST = /^login\.|^auth\.|accounts\.google|okta|onelogin|signin|microsoftonline/i

async function readOne(historyPath: string, sinceMs: number): Promise<WebVisit[]> {
  try {
    await stat(historyPath)
  } catch {
    return []
  }
  const tempDir = join(app.getPath('userData'), 'tmp')
  await mkdir(tempDir, { recursive: true }).catch(() => undefined)
  const temp = join(tempDir, `history-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)
  try {
    await copyFile(historyPath, temp)
    const initSqlJs = (await import('sql.js')).default
    const SQL = await initSqlJs()
    const { readFile } = await import('node:fs/promises')
    const db = new SQL.Database(await readFile(temp))
    const sinceWebkit = (sinceMs - WEBKIT_EPOCH_MS) * 1_000
    const rows = db.exec(
      `SELECT title, url, last_visit_time FROM urls
       WHERE last_visit_time > ${Math.floor(sinceWebkit)} AND title != ''
       ORDER BY last_visit_time DESC LIMIT 200`,
    )
    db.close()
    const visits: WebVisit[] = []
    for (const row of rows[0]?.values ?? []) {
      const [title, url, lastVisit] = row as [string, string, number]
      if (DENY_TITLE.test(title)) continue
      let host = ''
      try {
        host = new URL(url).host
      } catch {
        continue
      }
      if (DENY_HOST.test(host)) continue
      visits.push({ title: title.slice(0, 120), host, at: WEBKIT_EPOCH_MS + lastVisit / 1_000 })
    }
    return visits
  } catch (err) {
    flog('web-trail-read-failed', err)
    return []
  } finally {
    await rm(temp, { force: true }).catch(() => undefined)
  }
}

// Visits since `sinceMs`, both browsers merged, deduped by title.
export async function readWebTrail(sinceMs: number): Promise<WebVisit[]> {
  const all: WebVisit[] = []
  for (const candidate of historyCandidates()) all.push(...(await readOne(candidate, sinceMs)))
  const seen = new Set<string>()
  return all
    .sort((a, b) => b.at - a.at)
    .filter((v) => {
      const key = v.title.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

// The trail folded for a work log: top page titles grouped by host.
export function foldWebTrail(visits: WebVisit[], max = 8): string[] {
  const byHost = new Map<string, { count: number; titles: string[] }>()
  for (const v of visits) {
    const entry = byHost.get(v.host) ?? { count: 0, titles: [] }
    entry.count += 1
    if (entry.titles.length < 3) entry.titles.push(v.title)
    byHost.set(v.host, entry)
  }
  return [...byHost.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, max)
    .map(([host, e]) => `- ${host} (${e.count}) — ${e.titles.join(' · ')}`)
}

// Recent files (jump-list lite): the Recent folder's shortcut names carry the
// document names without parsing a single .lnk byte.
export async function recentFileNames(sinceMs: number): Promise<string[]> {
  const dirs =
    process.platform === 'win32'
      ? [{ dir: join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Recent'), ext: '.lnk' }]
      : process.platform === 'darwin'
        ? [
            { dir: join(homedir(), 'Desktop'), ext: '' },
            { dir: join(homedir(), 'Downloads'), ext: '' },
            { dir: join(homedir(), 'Documents'), ext: '' },
          ]
        : []
  if (dirs.length === 0) return []
  const out: { name: string; at: number }[] = []
  for (const { dir, ext } of dirs) {
    try {
      for (const entry of await readdir(dir)) {
        if (entry.startsWith('.')) continue
        if (ext && !entry.toLowerCase().endsWith(ext)) continue
        const s = await stat(join(dir, entry)).catch(() => null)
        if (!s || !s.isFile() || s.mtimeMs < sinceMs) continue
        out.push({ name: ext ? entry.slice(0, -ext.length) : entry, at: s.mtimeMs })
      }
    } catch {
      continue
    }
  }
  return out
    .sort((a, b) => b.at - a.at)
    .slice(0, 20)
    .map((e) => e.name)
}
