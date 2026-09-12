import { beforeEach, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const fake = vi.hoisted(() => ({ data: '', root: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fake.data } }))
vi.mock('../src/main/browser-import.js', () => ({ browserProfileRoots: () => [{ id: 'chrome', name: 'Chrome', userData: fake.root }] }))
import { bookmarkSources, importBookmarks, parseBookmarks, savedBookmarks } from '../src/main/browser-bookmarks.js'

const tree = (children: unknown[]) => JSON.stringify({ roots: { bookmark_bar: { name: 'Work', children } } })
beforeEach(async () => {
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
  expect(await importBookmarks('chrome:Default')).toEqual([{ title: '문서', url: 'https://example.com/docs', folder: 'Work' }])
  expect(await savedBookmarks()).toEqual([{ title: '문서', url: 'https://example.com/docs', folder: 'Work' }])
  await importBookmarks('chrome:Default')
  expect(await savedBookmarks()).toHaveLength(1)
  expect(await readFile(join(fake.root, 'Default', 'Cookies'), 'utf8')).toBe('unchanged')
  expect(await readFile(file, 'utf8')).toBe(tree([bookmark, bookmark]))
  await expect(importBookmarks('../../other')).rejects.toThrow('available browser profile')
  await mkdir(join(fake.root, 'Profile 1'), { recursive: true })
  await writeFile(join(fake.root, 'Profile 1', 'Bookmarks'), tree([{ type: 'url', url: 'https://example.com/other' }]))
  await Promise.all([importBookmarks('chrome:Default'), importBookmarks('chrome:Profile 1')])
  expect(await savedBookmarks()).toHaveLength(2)
})

it('rejects malformed or oversized trees and strips executable and credential-bearing URLs', () => {
  expect(parseBookmarks(tree(['javascript:alert(1)', 'file:///secret', 'https://name:password@example.com'].map((url) => ({ type: 'url', url }))))).toEqual([])
  expect(() => parseBookmarks('invalid')).toThrow()
  expect(() => parseBookmarks(' '.repeat(5_000_001))).toThrow('too large')
  let node: unknown = { type: 'url', url: 'https://example.com' }
  for (let i = 0; i < 22; i++) node = { children: [node] }
  expect(() => parseBookmarks(tree([node]))).toThrow('nested')
})
