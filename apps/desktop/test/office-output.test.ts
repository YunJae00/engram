import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
