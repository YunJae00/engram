import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { initVault, readNote, readWorkMap, type Engine } from 'core'

const fake = vi.hoisted(() => ({ data: '', history: '', workMap: true }))
vi.mock('electron', () => ({ app: { getPath: () => fake.data }, ipcMain: { handle: () => undefined } }))
vi.mock('../src/main/web-trail.js', () => ({ historyCandidates: () => [fake.history] }))
vi.mock('../src/main/browser-bookmarks.js', () => ({ allBookmarks: async () => [{ title: 'Tracker', url: 'https://tracker.example/board', folder: 'Dev', managed: false }] }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => ({ workMap: fake.workMap }) }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: () => undefined }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
import { refreshWorkMap, workMapSettingChanged, workMapShortcuts } from '../src/main/work-map-job.js'

afterEach(() => { vi.unstubAllEnvs(); fake.workMap = true })

const WEBKIT_EPOCH_MS = Date.UTC(1601, 0, 1)

it.each(['from_visit', 'opener_visit', 'both'])('reads portal relationships from the %s browser schema', async schema => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/work-map-via-'))
  fake.data = join(root, 'app'); fake.history = join(root, 'History')
  const SQL = await initSqlJs(), db = new SQL.Database()
  const columns = schema === 'both' ? ['from_visit', 'opener_visit'] : [schema]
  db.run(`CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER, ${columns.map(name => `${name} INTEGER`).join(', ')})`)
  db.run("INSERT INTO urls VALUES (1, 'https://portal.example/home', 'Portal', 0), (2, 'https://time.example/report', 'Time Report', 0)")
  for (const back of [1, 2]) {
    const at = (Date.now() - back * 86_400_000 - WEBKIT_EPOCH_MS) * 1000
    db.run('INSERT INTO visits (id, url, visit_time) VALUES (?, 1, ?)', [back * 10, at])
    db.run(`INSERT INTO visits (url, visit_time, ${columns.join(', ')}) VALUES (2, ?, ${columns.map(() => '?').join(', ')})`, [at + 1000, ...(schema === 'both' ? [0, back * 10] : [back * 10])])
  }
  await writeFile(fake.history, Buffer.from(db.export())); db.close()
  const paths = await initVault(join(root, 'vault'), { git: false })
  const engine = { id: 'mock', async *run() { yield { type: 'result', text: '[]' } } } as unknown as Engine
  const map = await refreshWorkMap({ paths, engines: [engine] } as unknown as Parameters<typeof refreshWorkMap>[0])
  expect(map?.places.find(place => place.host === 'time.example')?.via).toBe('portal.example')
})

it('maps the places in the browser history, names them once, and writes a note per work place', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/work-map-job-'))
  fake.data = join(root, 'app'); fake.history = join(root, 'History')
  const SQL = await initSqlJs()
  const db = new SQL.Database()
  db.run('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER); CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER, visit_time INTEGER)')
  db.run("INSERT INTO urls VALUES (1, 'https://time.example/report', 'Time Report', 0), (2, 'https://login.example/sso', 'Sign in', 0)")
  for (let back = 1; back <= 8; back++) for (const id of [1, 2]) db.run('INSERT INTO visits (url, visit_time) VALUES (?, ?)', [id, (Date.now() - back * 86_400_000 - WEBKIT_EPOCH_MS) * 1000])
  await writeFile(fake.history, Buffer.from(db.export()))
  const paths = await initVault(join(root, 'vault'), { git: false })
  const labels = JSON.stringify([{ n: 1, purpose: 'Bug tracker', work: true }, { n: 2, purpose: 'Log working hours', work: true }])
  const engine = { id: 'mock', detect: async () => ({ installed: true, loggedIn: true }), async *run() { yield { type: 'result', text: labels } } } as unknown as Engine
  const ctx = { paths, engines: [engine] } as unknown as Parameters<typeof refreshWorkMap>[0]
  const map = (await refreshWorkMap(ctx))!
  expect(map.places.map((place) => place.host)).toEqual(['tracker.example', 'time.example'])
  expect(await readWorkMap(paths)).toEqual(map)
  expect((await readNote(paths, 'n-place-time-example')).body).toContain('# Log working hours')
  expect(await workMapShortcuts(ctx)).toContain('- Log working hours: https://time.example/report')
  fake.workMap = false
  expect(await workMapShortcuts(ctx)).toBe('')
  expect(await refreshWorkMap(ctx)).toBeNull()
})

it('cancels the labelling call and discards its late result when learning is switched off', async () => {
  const root = await mkdtemp(resolve('tmp/work-map-cancel-'))
  fake.data = join(root, 'app'); fake.history = join(root, 'missing-history'); fake.workMap = true
  const paths = await initVault(join(root, 'vault'), { git: false })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  let finish!: () => void
  const waiting = new Promise<void>(resolve => { finish = resolve })
  let signal: AbortSignal | undefined
  const engine = { id: 'mock', async *run(job: { signal?: AbortSignal }) {
    signal = job.signal; started(); await waiting
    yield { type: 'result', text: '[{"n":1,"purpose":"Tracker","work":true}]' }
  } } as unknown as Engine
  const ctx = { paths, engines: [engine] } as unknown as Parameters<typeof refreshWorkMap>[0]
  const pending = refreshWorkMap(ctx)
  await ready
  fake.workMap = false; workMapSettingChanged(false)
  expect(signal?.aborted).toBe(true)
  finish()
  expect(await pending).toBeNull()
  expect(await readWorkMap(paths)).toBeNull()
  await expect(readNote(paths, 'n-place-tracker-example')).rejects.toThrow()
})

it('never reads browser sources from an isolated app profile, including manual refresh', async () => {
  vi.stubEnv('ENGRAM_USERDATA', 'isolated-test-profile')
  expect(await refreshWorkMap({} as Parameters<typeof refreshWorkMap>[0])).toBeNull()
})
