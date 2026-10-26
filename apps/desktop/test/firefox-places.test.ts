import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import initSqlJs from 'sql.js'

vi.mock('electron', () => ({ app: { getPath: () => resolve('tmp') } }))
vi.mock('../src/main/flog.js', () => ({ flog: () => undefined }))
const { firefoxBookmarks, firefoxVisits } = await import('../src/main/firefox-places.js')
const { profileDirs } = await import('../src/main/browser-roots.js')

async function places() {
  const SQL = await initSqlJs(), db = new SQL.Database()
  db.run('CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, hidden INTEGER); CREATE TABLE moz_historyvisits (id INTEGER PRIMARY KEY, place_id INTEGER, visit_date INTEGER, from_visit INTEGER); CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, parent INTEGER, type INTEGER, title TEXT, guid TEXT, fk INTEGER)')
  db.run("INSERT INTO moz_places VALUES (1, 'https://portal.example/home', 'Portal', 0), (2, 'https://time.example/report', 'Time Report', 0), (3, 'javascript:alert(1)', 'Bad', 0), (4, 'https://hidden.example/', 'Hidden', 1)")
  const at = (Date.now() - 86_400_000) * 1000
  db.run('INSERT INTO moz_historyvisits VALUES (10, 1, ?, 0), (11, 2, ?, 10), (12, 4, ?, 0), (13, 1, 1000, 0)', [at, at + 1000, at])
  db.run("INSERT INTO moz_bookmarks VALUES (1, 0, 2, '', 'root________', NULL), (2, 1, 2, 'toolbar', 'toolbar_____', NULL), (3, 2, 2, 'Work', 'f1', NULL), (4, 3, 1, 'Time', 'b1', 2), (5, 3, 1, 'Bad', 'b2', 3), (6, 1, 2, 'tags', 'tags________', NULL), (7, 6, 2, 'urgent', 't1', NULL), (8, 7, 1, NULL, 't2', 1)")
  return db
}

it('reads Firefox visits with where they came from, and bookmarks with their folders but not tags', async () => {
  const db = await places()
  const visits = firefoxVisits(db, Date.now() - 30 * 86_400_000)
  expect(visits.map(visit => visit.url)).toEqual(['https://portal.example/home', 'https://time.example/report'])
  expect(visits[1]).toMatchObject({ title: 'Time Report', from: 'https://portal.example/home' })
  expect(Math.abs(visits[0]!.at - (Date.now() - 86_400_000))).toBeLessThan(5_000)
  expect(firefoxBookmarks(db)).toEqual([{ title: 'Time', url: 'https://time.example/report', folder: 'toolbar / Work', folderPath: ['toolbar', 'Work'] }])
})

it('finds every profile folder, or the browser folder itself when it holds the one profile', async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/browser-roots-'))
  await mkdir(join(root, 'many', 'Default'), { recursive: true })
  await mkdir(join(root, 'many', 'Profile 2'), { recursive: true })
  await mkdir(join(root, 'many', 'System Profile'), { recursive: true })
  await mkdir(join(root, 'one'), { recursive: true })
  await writeFile(join(root, 'one', 'History'), '')
  expect(profileDirs(join(root, 'many')).sort()).toEqual(['Default', 'Profile 2'])
  expect(profileDirs(join(root, 'one'))).toEqual(['.'])
  expect(profileDirs(join(root, 'missing'))).toEqual([])
})
