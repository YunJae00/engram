import { beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const fake = vi.hoisted(() => ({ data: '', root: '', managed: [] as { id: string; name: string; text: string }[] }))
vi.mock('../src/main/managed-bookmarks.js', () => ({ managedBookmarkSources: () => fake.managed }))
vi.mock('electron', () => ({ app: { getPath: () => fake.data } }))
vi.mock('../src/main/browser-import.js', () => ({ browserProfileRoots: () => [{ id: 'chrome', name: 'Chrome', userData: fake.root }] }))
import { bookmarkSources, importBookmarks, parseBookmarks, savedBookmarks } from '../src/main/browser-bookmarks.js'

const tree = (children: unknown[]) => JSON.stringify({ roots: { bookmark_bar: { name: 'Work', children } } })
beforeEach(async () => {
  fake.managed = []
  await mkdir(resolve('tmp'), { recursive: true })
  const root = await mkdtemp(resolve('tmp/bookmarks-test-'))
  fake.data = join(root, 'app'); fake.root = join(root, 'browser')
  await mkdir(join(fake.root, 'Default'), { recursive: true })
})

it('imports actual profile bookmarks without reading or changing sign-in files', async () => {
  const bookmark = { type: 'url', name: '문서', url: 'https://example.com/docs' }
  const file = join(fake.root, 'Default', 'Bookmarks')
  await writeFile(file, tree([bookmark, bookmark]))
  await writeFile(join(fake.root, 'Default', 'Cookies'), 'unchanged')
  expect(await bookmarkSources()).toEqual([{ id: 'chrome:Default', name: 'Chrome · Default' }])
  await writeFile(join(fake.root, 'Local State'), JSON.stringify({ profile: { info_cache: { Default: { name: 'Work' } } } }))
  expect(await bookmarkSources()).toEqual([{ id: 'chrome:Default', name: 'Chrome · Work' }])
  const expected = [{ title: '문서', url: 'https://example.com/docs', folder: 'Work', folderPath: ['Work'], sourceId: 'chrome:Default', sourceName: 'Chrome · Work' }]
  expect(await importBookmarks('chrome:Default')).toEqual(expected)
  expect(await savedBookmarks()).toEqual(expected)
  await importBookmarks('chrome:Default')
  expect(await savedBookmarks()).toHaveLength(1)
  expect(await readFile(join(fake.root, 'Default', 'Cookies'), 'utf8')).toBe('unchanged')
  expect(await readFile(file, 'utf8')).toBe(tree([bookmark, bookmark]))
  await expect(importBookmarks('../../other')).rejects.toThrow('available browser profile')
  await mkdir(join(fake.root, 'Profile 1'), { recursive: true })
  await writeFile(join(fake.root, 'Profile 1', 'Bookmarks'), tree([bookmark]))
  await Promise.all([importBookmarks('chrome:Default'), importBookmarks('chrome:Profile 1')])
  expect(await savedBookmarks()).toHaveLength(2)
})

it('imports managed favorites with nested folders and keeps personal copies separate', async () => {
  const policy = JSON.stringify([{ toplevel_name: 'Company bookmarks' }, { name: 'Tools', children: [{ name: 'Portal', url: 'example.com' }, { name: 'Unsafe', url: 'javascript:alert(1)' }] }])
  fake.managed = [{ id: 'chrome:managed:HKLM', name: 'Organization · Device', text: policy }]
  await writeFile(join(fake.root, 'Default', 'Bookmarks'), tree([{ type: 'url', url: 'https://example.com' }]))
  expect(await bookmarkSources()).toContainEqual({ id: 'chrome:managed:HKLM', name: 'Chrome · Organization · Device' })
  expect(await importBookmarks('chrome:managed:HKLM')).toEqual([{ title: 'Portal', url: 'https://example.com/', folder: 'Company bookmarks / Tools', folderPath: ['Company bookmarks', 'Tools'], sourceId: 'chrome:managed:HKLM', sourceName: 'Chrome · Organization · Device' }])
  await importBookmarks('chrome:Default')
  await importBookmarks('chrome:managed:HKLM')
  expect(await savedBookmarks()).toHaveLength(2)
  expect(fake.managed[0]!.text).toBe(policy)
})

it('rejects malformed or oversized trees and strips executable and credential-bearing URLs', () => {
  expect(parseBookmarks(tree(['javascript:alert(1)', 'file:///secret', 'https://name:password@example.com'].map((url) => ({ type: 'url', url }))))).toEqual([])
  expect(() => parseBookmarks('invalid')).toThrow()
  expect(() => parseBookmarks(' '.repeat(5_000_001))).toThrow('too large')
  let node: unknown = { type: 'url', url: 'https://example.com' }
  for (let i = 0; i < 22; i++) node = { children: [node] }
  expect(() => parseBookmarks(tree([node]))).toThrow('nested')
})

it('reports an empty profile without claiming an import succeeded or replacing existing bookmarks', async () => {
  await writeFile(join(fake.root, 'Default', 'Bookmarks'), tree([]))
  await expect(importBookmarks('chrome:Default')).rejects.toThrow('no supported bookmarks')
  expect(await savedBookmarks()).toEqual([])
})
