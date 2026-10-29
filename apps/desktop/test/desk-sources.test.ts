import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { DESK_NOTES, initVault, NoteStore, readNote, type VaultPaths } from 'core'

const fake = vi.hoisted(() => ({
  data: '', history: '', settings: { workMap: false, workFiles: false, workApps: false }, targets: new Map<string, string>(), reg: '',
}))
vi.mock('electron', () => ({ app: { getPath: () => fake.data }, shell: { readShortcutLink: (path: string) => ({ target: fake.targets.get(path.split(/[\\/]/).pop()!) ?? '' }) } }))
vi.mock('node:child_process', () => ({ execFile: (_cmd: string, _args: string[], _options: object, done: (error: null, result: { stdout: string }) => void) => done(null, { stdout: fake.reg }) }))
vi.mock('../src/main/mac-app-usage.js', () => ({ readMacAppUse: async () => [] }))
vi.mock('../src/main/web-trail.js', () => ({ historyCandidates: () => [fake.history] }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => fake.settings }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: () => undefined }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
import { refreshDeskNotes, withheldDeskNotes } from '../src/main/desk-sources.js'

const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1)
let root: string, paths: VaultPaths, ctx: Parameters<typeof refreshDeskNotes>[0]

function usage(name: string, runs: number): string {
  const data = Buffer.alloc(72)
  data.writeUInt32LE(runs, 4)
  data.writeUInt32LE(runs * 60_000, 12)
  const encoded = name.replace(/[a-z]/gi, ch => String.fromCharCode((ch <= 'Z' ? 65 : 97) + (ch.toLowerCase().charCodeAt(0) - 97 + 13) % 26))
  return `    ${encoded}    REG_BINARY    ${data.toString('hex')}`
}

beforeEach(async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  root = await mkdtemp(resolve('tmp/desk-sources-'))
  vi.stubEnv('ENGRAM_USERDATA', '')
  vi.stubEnv('APPDATA', join(root, 'appdata'))
  fake.data = join(root, 'app'); fake.history = join(root, 'History')
  fake.settings = { workMap: false, workFiles: false, workApps: false }
  fake.reg = [usage('C:\\Program Files\\Office\\EXCEL.EXE', 12), usage('C:\\Tools\\Report Setup.exe', 1)].join('\r\n')
  const SQL = await initSqlJs(), db = new SQL.Database()
  db.run('CREATE TABLE downloads (id INTEGER PRIMARY KEY, target_path TEXT, start_time INTEGER, tab_url TEXT, referrer TEXT, site_url TEXT)')
  db.run('INSERT INTO downloads (target_path, start_time, tab_url, referrer, site_url) VALUES (?, ?, ?, ?, ?)', ['C:\\Users\\me\\Downloads\\timesheet.xlsx', (Date.now() - 86_400_000 - WEBKIT_EPOCH_MS) * 1000, 'https://hr.example/sheet', '', ''])
  await writeFile(fake.history, Buffer.from(db.export())); db.close()
  paths = await initVault(join(root, 'vault'), { git: false })
  ctx = { paths, store: await NoteStore.open(paths) } as unknown as typeof ctx
})
afterEach(() => { vi.unstubAllEnvs() })

it('writes a note only for each source the person allowed, and withholds the rest from filing', async () => {
  fake.settings = { workMap: true, workFiles: false, workApps: true }
  await refreshDeskNotes(ctx)
  if (process.platform === 'win32') {
    expect((await readNote(paths, DESK_NOTES.apps)).body).toContain('- EXCEL: opened 12 times')
    expect((await readNote(paths, DESK_NOTES.apps)).body).not.toContain('Setup')
  } else await expect(readNote(paths, DESK_NOTES.apps)).rejects.toThrow()
  expect((await readNote(paths, DESK_NOTES.downloads)).body).toContain('- hr.example: 1 file, such as timesheet.xlsx')
  await expect(readNote(paths, DESK_NOTES.files)).rejects.toThrow()
  expect(await withheldDeskNotes()).toEqual([DESK_NOTES.files])
  fake.settings = { workMap: false, workFiles: false, workApps: false }
  expect(await withheldDeskNotes()).toEqual(Object.values(DESK_NOTES))
})

it.runIf(process.platform === 'win32')('rereads app usage at most daily unless it was just allowed', async () => {
  fake.settings = { workMap: false, workFiles: false, workApps: true }
  await refreshDeskNotes(ctx)
  fake.reg = usage('C:\\Program Files\\Office\\WINWORD.EXE', 3)
  await refreshDeskNotes(ctx)
  expect((await readNote(paths, DESK_NOTES.apps)).body).toContain('EXCEL')
  await refreshDeskNotes(ctx, true)
  expect((await readNote(paths, DESK_NOTES.apps)).body).toContain('WINWORD')
})

it('reads downloads when the history has only one origin column', async () => {
  fake.settings.workMap = true
  const SQL = await initSqlJs(), db = new SQL.Database()
  db.run('CREATE TABLE downloads (target_path TEXT, start_time INTEGER, tab_url TEXT)')
  db.run('INSERT INTO downloads VALUES (?, ?, ?)', ['C:\\Downloads\\report.xlsx', (Date.now() - WEBKIT_EPOCH_MS) * 1000, 'https://work.example/report'])
  await writeFile(fake.history, Buffer.from(db.export())); db.close()
  await refreshDeskNotes(ctx)
  expect((await readNote(paths, DESK_NOTES.downloads)).body).toContain('work.example: 1 file, such as report.xlsx')
})

it.runIf(process.platform === 'win32')('reads recent files by name, leaving out Engram\'s own workspace', async () => {
  fake.settings = { workMap: false, workFiles: true, workApps: false }
  const recent = join(root, 'appdata', 'Microsoft', 'Windows', 'Recent')
  await mkdir(recent, { recursive: true })
  for (const [link, target] of [['q3.lnk', 'C:\\Work\\Reports\\Q3.xlsx'], ['folder.lnk', 'C:\\Work\\Reports'], ['own.lnk', join(root, 'vault', 'workspace', 'note.md')]] as const) {
    await writeFile(join(recent, link), '')
    fake.targets.set(link, target)
  }
  await refreshDeskNotes(ctx)
  const body = (await readNote(paths, DESK_NOTES.files)).body
  expect(body).toContain('- C:\\Work\\Reports: 1 file, such as Q3.xlsx')
  expect(body).not.toContain('note.md')
})
