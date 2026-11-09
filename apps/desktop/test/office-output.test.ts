import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ directory: '' }))
vi.mock('electron', () => ({ app: { getPath: () => fake.directory } }))
import { saveOfficeOutput } from '../src/main/office-output.js'

beforeEach(async () => {
  const root = resolve('tmp')
  await mkdir(root, { recursive: true })
  fake.directory = await mkdtemp(join(root, 'office-output-'))
})
afterEach(async () => { await rm(fake.directory, { recursive: true, force: true }) })

it('never overwrites an existing output, including parallel calls', async () => {
  const path = join(fake.directory, 'test.docx')
  const results = await Promise.allSettled([
    saveOfficeOutput('test', '.docx', Buffer.from('first'), path),
    saveOfficeOutput('test', '.docx', Buffer.from('second'), path),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  const content = await readFile(path, 'utf8')
  await expect(saveOfficeOutput('test', '.docx', Buffer.from('changed'), path)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path, 'utf8')).toBe(content)
})
it('uses separate default filenames and stops before writing after cancellation', async () => {
  const a = await saveOfficeOutput('Same', '.pptx', Buffer.from('a'))
  const b = await saveOfficeOutput('Same', '.pptx', Buffer.from('b'))
  expect(a).not.toBe(b)
  const controller = new AbortController()
  controller.abort()
  const path = join(fake.directory, 'cancelled.docx')
  await expect(saveOfficeOutput('test', '.docx', Buffer.from('data'), path, controller.signal)).rejects.toThrow()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
})
it('rejects non-document paths and turn stops', async () => {
  await expect(saveOfficeOutput('test', '.docx', Buffer.from('data'), join(fake.directory, 'file.exe'))).rejects.toThrow('absolute')
  await expect(saveOfficeOutput('test', '.docx', Buffer.from('data'), undefined, undefined, () => { throw new Error('stopped') })).rejects.toThrow('stopped')
})
it('keeps a document asked for by a bare name in the usual folder under that name', async () => {
  const first = await saveOfficeOutput('ignored', '.docx', Buffer.from('a'), '팀 회의 안건.docx')
  expect(first).toBe(join(fake.directory, 'Engram', '팀 회의 안건.docx'))
  const second = await saveOfficeOutput('ignored', '.docx', Buffer.from('b'), '팀 회의 안건')
  expect(second).toBe(join(fake.directory, 'Engram', '팀 회의 안건 (2).docx'))
  expect(await readFile(first, 'utf8')).toBe('a')
})
it('names a second save of the same title readably and keeps the first', async () => {
  const first = await saveOfficeOutput('주간회의록', '.docx', Buffer.from('a'))
  const second = await saveOfficeOutput('주간회의록', '.docx', Buffer.from('b'))
  expect(first).toBe(join(fake.directory, 'Engram', '주간회의록.docx'))
  expect(second).toBe(join(fake.directory, 'Engram', '주간회의록 (2).docx'))
  for (const path of [first, second]) expect(path).not.toMatch(/-[0-9a-f]{8}((-[0-9a-f]{4}){3}-[0-9a-f]{12})?\.docx$/)
  expect(await readFile(first, 'utf8')).toBe('a')
  expect(await readFile(second, 'utf8')).toBe('b')
})
it('gives parallel saves of one title distinct names without overwriting', async () => {
  const paths = await Promise.all(['1', '2', '3'].map((d) => saveOfficeOutput('Same', '.docx', Buffer.from(d))))
  const folder = join(fake.directory, 'Engram')
  expect(new Set(paths)).toEqual(new Set(['Same.docx', 'Same (2).docx', 'Same (3).docx'].map((n) => join(folder, n))))
  expect(new Set(await Promise.all(paths.map((p) => readFile(p, 'utf8'))))).toEqual(new Set(['1', '2', '3']))
})
it('keeps dot-only names inside the usual folder', async () => {
  const folder = join(fake.directory, 'Engram')
  expect(await saveOfficeOutput('ignored', '.docx', Buffer.from('a'), '..')).toBe(join(folder, '...docx'))
  expect(await saveOfficeOutput('..', '.docx', Buffer.from('b'))).toBe(join(folder, '.. (2).docx'))
})
it('skips reserved device names and stops after the numbered range', async () => {
  const folder = join(fake.directory, 'Engram')
  expect(await saveOfficeOutput('CON', '.docx', Buffer.from('a'))).toBe(join(folder, 'CON (2).docx'))
  const names = ['X.docx', ...Array.from({ length: 98 }, (_, i) => `X (${i + 2}).docx`)]
  for (const name of names) await writeFile(join(folder, name), '')
  await expect(saveOfficeOutput('X', '.docx', Buffer.from('new'))).rejects.toThrow(/Too many files/)
  for (const name of names) expect(await readFile(join(folder, name), 'utf8')).toBe('')
})
it('writes nothing for an untitled save cancelled before it starts', async () => {
  const folder = join(fake.directory, 'Engram')
  await mkdir(folder, { recursive: true })
  const controller = new AbortController()
  controller.abort()
  await expect(saveOfficeOutput('Late', '.docx', Buffer.from('x'), undefined, controller.signal)).rejects.toThrow()
  expect(await readdir(folder)).toEqual([])
})
