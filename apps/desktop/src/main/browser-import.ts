import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { flog } from './flog.js'

// The person is already signed in — in their own browser, to their own
// accounts. The agent window starts empty, so it asks them to sign in again
// to things they never signed out of. Chrome closed that door from the other
// side: since it began ignoring remote debugging on the live profile, the
// only honest way to inherit those sessions is to copy them across while the
// browser is not holding them open. Work accounts usually need none of this —
// a Windows sign-in follows into a fresh profile on its own — so this exists
// for the rest: the portals and personal accounts with cookies of their own.

// What carries a session and nothing else: the key store, the cookie jar, and
// the small files that make the window feel like theirs. Caches, history and
// passwords are deliberately not on this list.
const SESSION_FILES = [
  'Local State',
  join('Default', 'Network', 'Cookies'),
  join('Default', 'Preferences'),
  join('Default', 'Bookmarks'),
] as const

export interface BrowserSource {
  id: string
  name: string
  userData: string
  running: boolean
}

function sources(): Omit<BrowserSource, 'running'>[] {
  const local = process.env['LOCALAPPDATA'] ?? ''
  if (process.platform === 'win32')
    return [
      { id: 'chrome', name: 'Chrome', userData: join(local, 'Google', 'Chrome', 'User Data') },
      { id: 'edge', name: 'Edge', userData: join(local, 'Microsoft', 'Edge', 'User Data') },
    ].filter((one) => existsSync(one.userData))
  const home = process.env['HOME'] ?? ''
  if (process.platform === 'darwin')
    return [
      { id: 'chrome', name: 'Chrome', userData: join(home, 'Library', 'Application Support', 'Google', 'Chrome') },
      { id: 'edge', name: 'Edge', userData: join(home, 'Library', 'Application Support', 'Microsoft Edge') },
    ].filter((one) => existsSync(one.userData))
  return [{ id: 'chrome', name: 'Chrome', userData: join(home, '.config', 'google-chrome') }].filter((one) =>
    existsSync(one.userData),
  )
}

// A browser holding its own profile open cannot be copied from: the cookie
// jar is locked, and a half-copied jar is worse than none. Rather than guess
// from process names, the check is the copy itself — see importBrowserSession.
export async function listBrowserSources(): Promise<BrowserSource[]> {
  const found: BrowserSource[] = []
  for (const source of sources()) {
    const locked = await isLocked(join(source.userData, 'Default', 'Network', 'Cookies'))
    found.push({ ...source, running: locked })
  }
  return found
}

async function isLocked(file: string): Promise<boolean> {
  if (!existsSync(file)) return false
  const probe = join(app.getPath('temp'), `engram-lock-probe-${Date.now()}`)
  try {
    await copyFile(file, probe)
    await rm(probe, { force: true }).catch(() => undefined)
    return false
  } catch {
    return true
  }
}

export interface ImportResult {
  ok: boolean
  copied?: number
  error?: string
}

// Copies the session across. Refuses rather than half-copies: a cookie jar
// that arrives without its key store is a profile that silently knows nobody.
export async function importBrowserSession(id: string): Promise<ImportResult> {
  const source = sources().find((one) => one.id === id)
  if (!source) return { ok: false, error: 'that browser is not installed here' }
  const target = join(app.getPath('userData'), 'agent-browser-profile')
  const cookies = join(source.userData, 'Default', 'Network', 'Cookies')
  if (await isLocked(cookies))
    return { ok: false, error: 'the browser is still open — close it completely and try again' }
  let copied = 0
  try {
    await mkdir(join(target, 'Default', 'Network'), { recursive: true })
    for (const rel of SESSION_FILES) {
      const from = join(source.userData, rel)
      if (!existsSync(from)) continue
      await copyFile(from, join(target, rel))
      copied++
    }
    // The cookie jar's write-ahead log holds the newest sessions; without it a
    // login from the last few minutes is simply missing.
    for (const suffix of ['-journal', '-wal', '-shm']) {
      const from = `${cookies}${suffix}`
      if (existsSync(from)) await copyFile(from, join(target, 'Default', 'Network', `Cookies${suffix}`))
    }
  } catch (err) {
    return { ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 160) }
  }
  if (copied === 0) return { ok: false, error: 'nothing to copy from that browser' }
  flog('browser-import', `imported ${copied} file(s) from ${source.name}`)
  return { ok: true, copied }
}

// What the person gets back if they change their mind: the imported profile
// is ours, so forgetting it is just deleting it.
export async function forgetImportedSession(): Promise<void> {
  const target = join(app.getPath('userData'), 'agent-browser-profile')
  const entries = await readdir(target).catch(() => [] as string[])
  if (entries.length === 0) return
  await rm(target, { recursive: true, force: true }).catch(() => undefined)
  flog('browser-import', 'forgot the imported session')
}

export async function importedAt(): Promise<string | null> {
  const cookies = join(app.getPath('userData'), 'agent-browser-profile', 'Default', 'Network', 'Cookies')
  const info = await stat(cookies).catch(() => null)
  return info ? info.mtime.toISOString() : null
}
