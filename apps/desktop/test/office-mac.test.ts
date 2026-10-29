import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const fake = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('electron', () => ({ app: { isPackaged: false } }))
vi.mock('node:child_process', () => ({ execFile: fake.exec }))
vi.mock('../src/main/desktop-host.js', () => ({ DesktopHost: class {} }))
import { macOfficeRequest, closeMacOffice } from '../src/main/office-mac.js'
let directory: string, file: string
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'engram-office-unit-'))
  file = join(directory, 'owned.docx')
  await writeFile(file, 'owned fixture bytes')
  fake.exec.mockImplementation((_command, args: string[], _options, done: (error: Error | null, stdout: string, stderr: string) => void) => {
    void readFile(args.at(-1)!, 'utf8').then(text => {
      const request = JSON.parse(text)
      done(null, JSON.stringify(request.op.endsWith('.read') ? { file, content: [{ key: 'body', text: 'Original\r' }] } : { applied: 1 }), '')
    })
    return { kill: vi.fn() }
  })
})
afterEach(async () => { closeMacOffice(); vi.clearAllMocks(); await rm(directory, { recursive: true, force: true }) })
it('binds revisions to unchanged disk contents and consumes a failed edit', async () => {
  const read = await macOfficeRequest('word.read', { file }) as { revision: string }
  await writeFile(file, 'changed outside Engram')
  const edit = { file, revision: read.revision, edits: [{ kind: 'append', text: 'More' }] }
  await expect(macOfficeRequest('word.edit', edit)).rejects.toThrow('Read this document again')
  await writeFile(file, 'owned fixture bytes')
  await expect(macOfficeRequest('word.edit', edit)).rejects.toThrow('Read this document again')
  expect(fake.exec).toHaveBeenCalledOnce()
})
it('preserves the original disk bytes in a unique backup before an explicit save', async () => {
  const read = await macOfficeRequest('word.read', { file }) as { revision: string }
  const result = await macOfficeRequest('word.edit', { file, revision: read.revision, edits: [{ kind: 'append', text: 'More' }], save: true }) as { backup: string }
  expect(await readFile(result.backup, 'utf8')).toBe('owned fixture bytes')
  expect(result.backup).not.toBe(file)
})
it('never dispatches a pre-cancelled request or an overwrite via save-as', async () => {
  await expect(macOfficeRequest('word.read', { file }, AbortSignal.abort())).rejects.toThrow()
  await expect(macOfficeRequest('excel.write', { workbook: 'new', sheet: 'Sheet1', cells: [], saveAs: file })).rejects.toThrow('new absolute path')
  expect(fake.exec).not.toHaveBeenCalled()
})
