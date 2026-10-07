import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'
import { buildWorkMap, engineBackoff, initVault, NoteStore, readNote, readWorkMap, writeWorkMap, type Engine, type EngineJobInput } from 'core'

const fake = vi.hoisted(() => ({ data: '', history: '', workMap: true, sources: vi.fn(), bookmarks: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: () => fake.data }, ipcMain: { handle: () => undefined } }))
vi.mock('../src/main/web-trail.js', () => ({ historyCandidates: fake.sources }))
vi.mock('../src/main/browser-bookmarks.js', () => ({ allBookmarks: fake.bookmarks }))
vi.mock('../src/main/settings.js', () => ({ loadSettings: async () => ({ workMap: fake.workMap }) }))
vi.mock('../src/main/engine-health.js', () => ({ broadcast: () => undefined }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
import { primeWorkMap, refreshWorkMap, startWorkMap, workMapSettingChanged, workMapShortcuts } from '../src/main/work-map-job.js'

const bookmarks = [{ title: 'Tracker', url: 'https://tracker.example/board', folder: 'Dev', managed: false }]
beforeEach(async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  vi.stubEnv('ENGRAM_USERDATA', '')
  fake.workMap = true
  fake.sources.mockReset().mockImplementation(() => [fake.history])
  fake.bookmarks.mockReset().mockResolvedValue(bookmarks)
  engineBackoff.noteOk()
})
afterEach(() => { vi.unstubAllEnvs(); engineBackoff.noteOk() })

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
  const map = await refreshWorkMap({ paths, engines: [engine], store: await NoteStore.open(paths) } as unknown as Parameters<typeof refreshWorkMap>[0])
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
  const ctx = { paths, engines: [engine], store: await NoteStore.open(paths) } as unknown as Parameters<typeof refreshWorkMap>[0]
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
  const ctx = { paths, engines: [engine], store: await NoteStore.open(paths) } as unknown as Parameters<typeof refreshWorkMap>[0]
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

async function setupPrime(reply: (job: EngineJobInput) => string | Promise<string> = () => '[{"n":1,"purpose":"Tracker","work":true}]') {
  const root = await mkdtemp(resolve('tmp/work-map-prime-'))
  fake.data = join(root, 'app'); fake.history = join(root, 'missing-history')
  const paths = await initVault(join(root, 'vault'), { git: false })
  const jobs: EngineJobInput[] = []
  const engine = { id: 'mock', async *run(job: EngineJobInput) {
    jobs.push(job)
    yield { type: 'result', text: await reply(job) }
  } } as unknown as Engine
  const ctx = { paths, engines: [engine], store: await NoteStore.open(paths) } as unknown as Parameters<typeof primeWorkMap>[0]
  const filed = vi.fn()
  // Register the callback without starting background timers in this fixture.
  vi.stubEnv('ENGRAM_USERDATA', 'isolated-test-profile')
  startWorkMap(ctx, filed)
  vi.stubEnv('ENGRAM_USERDATA', '')
  return { ctx, jobs, filed }
}

it('primes a missing map once and updates the store before waking filing', async () => {
  const { ctx, jobs, filed } = await setupPrime()
  const applyFile = vi.spyOn(ctx.store, 'applyFile')
  filed.mockImplementation(() => {
    expect(ctx.store.get('n-place-tracker-example')?.body).toContain('# Tracker')
    expect(applyFile).toHaveBeenCalledWith('add', join(ctx.paths.notes, 'n-place-tracker-example.md'))
  })
  await primeWorkMap(ctx)
  expect(jobs).toHaveLength(1)
  expect(filed).toHaveBeenCalledTimes(1)
  expect((await readWorkMap(ctx.paths))?.places[0]?.work).toBe(true)
  await primeWorkMap(ctx)
  expect(jobs).toHaveLength(1)
  expect(fake.bookmarks).toHaveBeenCalledTimes(1)
  expect(filed).toHaveBeenCalledTimes(1)
})

it.each(['classified', 'empty'])('leaves a saved %s map for its normal refresh cadence', async state => {
  const { ctx, jobs, filed } = await setupPrime()
  const map = buildWorkMap([], state === 'empty' ? [] : bookmarks, new Date('2020-01-01'))
  map.places = map.places.map(place => ({ ...place, work: false }))
  await writeWorkMap(ctx.paths, map)
  await primeWorkMap(ctx)
  expect(jobs).toHaveLength(0)
  expect(fake.sources).not.toHaveBeenCalled()
  expect(fake.bookmarks).not.toHaveBeenCalled()
  expect(filed).not.toHaveBeenCalled()
  expect(await readWorkMap(ctx.paths)).toEqual(map)
})

it('finishes classifying an earlier map when an AI becomes available', async () => {
  const { ctx, jobs, filed } = await setupPrime()
  await writeWorkMap(ctx.paths, buildWorkMap([], bookmarks, new Date()))
  await primeWorkMap(ctx)
  expect(jobs).toHaveLength(1)
  expect((await readWorkMap(ctx.paths))?.places[0]?.work).toBe(true)
  expect(filed).toHaveBeenCalledTimes(1)
})

it.each(['opt-out', 'no engine', 'quota', 'isolated profile'])('does not read a map or browser sources when priming is blocked by %s', async reason => {
  if (reason === 'opt-out') fake.workMap = false
  if (reason === 'quota') engineBackoff.noteQuota(60_000)
  if (reason === 'isolated profile') vi.stubEnv('ENGRAM_USERDATA', 'isolated-test-profile')
  const run = vi.fn()
  const ctx = { engines: reason === 'no engine' ? [] : [{ run }] } as unknown as Parameters<typeof primeWorkMap>[0]
  // No paths are supplied: reading even the stored map would fail this check.
  await primeWorkMap(ctx)
  expect(run).not.toHaveBeenCalled()
  expect(fake.sources).not.toHaveBeenCalled()
  expect(fake.bookmarks).not.toHaveBeenCalled()
})

it('coalesces initial preparation and manual refresh into one model call and filing wake-up', async () => {
  let started!: () => void, finish!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const waiting = new Promise<void>(resolve => { finish = resolve })
  const { ctx, jobs, filed } = await setupPrime(async () => {
    started(); await waiting
    return '[{"n":1,"purpose":"Tracker","work":true}]'
  })
  const first = primeWorkMap(ctx)
  await ready
  const again = primeWorkMap(ctx), manual = refreshWorkMap(ctx)
  expect(jobs).toHaveLength(1)
  finish()
  await Promise.all([first, again, manual])
  expect(jobs).toHaveLength(1)
  expect(fake.bookmarks).toHaveBeenCalledTimes(1)
  expect(filed).toHaveBeenCalledTimes(1)
})

it('does not wake filing when the map produces no work notes', async () => {
  const { ctx, filed } = await setupPrime(() => '[{"n":1,"work":false}]')
  await primeWorkMap(ctx)
  expect((await readWorkMap(ctx.paths))?.places[0]?.work).toBe(false)
  expect(ctx.store.getAll()).toEqual([])
  expect(filed).not.toHaveBeenCalled()
})
