import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { flog } from './flog.js'

const SESSION_FILES = [
  'Local State',
  join('Default', 'Network', 'Cookies'),
  join('Default', 'Preferences'),
  join('Default', 'Bookmarks'),
  join('Default', 'AccountBookmarks'),
] as const

interface BrowserSource {
  id: string
  name: string
  userData: string
  running: boolean
}

function browserProfileRoots(): Omit<BrowserSource, 'running'>[] {
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

export async function listBrowserSources(): Promise<BrowserSource[]> {
  const found: BrowserSource[] = []
  for (const source of browserProfileRoots()) {
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

interface ImportResult {
  ok: boolean
  copied?: number
  error?: string
}

export async function importBrowserSession(id: string): Promise<ImportResult> {
  const source = browserProfileRoots().find((one) => one.id === id)
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

const AUTO_IMPORT_EVERY_MS = 24 * 60 * 60 * 1000

export async function autoImportSession(preferredName: string | null): Promise<void> {
  if (process.env['ENGRAM_USERDATA']) return
  const last = await importedAt()
  if (last && Date.now() - new Date(last).getTime() < AUTO_IMPORT_EVERY_MS) return
  const all = browserProfileRoots()
  const wanted = preferredName ? all.filter((one) => preferredName.toLowerCase().includes(one.id)) : all
  const source = wanted.length === 1 ? wanted[0] : preferredName ? wanted[0] : all.length === 1 ? all[0] : null
  if (!source) return
  const result = await importBrowserSession(source.id)
  if (result.ok) flog('browser-import', `auto: carried ${source.name} sign-ins across`)
}

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
