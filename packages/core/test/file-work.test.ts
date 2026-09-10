import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileWorkTools, resolveArtifact } from '../src/file-work.js'
import { workbookTool } from '../src/file-workbook.js'

let root: string
beforeEach(async () => { await mkdir('tmp', { recursive: true }); root = await mkdtemp(resolve('tmp/file-work-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const context = { task: 'Create a revised copy, preserving the source.' }
function tools(approveRead = async () => true) {
  const all = fileWorkTools({ directory: join(root, 'outputs'), approveRead })
  return async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => JSON.parse(await all.find((tool) => tool.name === name)!.run(args, { ...context, signal }))
}

it('reads an approved revision, creates and verifies a copy, and never changes the source', async () => {
  const path = join(root, 'data.json')
  await writeFile(path, '{"amount":10,"keep":"unchanged"}')
  let approvals = 0
  const call = tools(async () => { approvals++; return true })
  const source = await call('file_read', { path })
  const output = await call('file_create_copy', { name: 'revised.json', sourcePath: path, expectedSha256: source.sha256, content: '{"amount":20,"keep":"unchanged"}' })
  expect(JSON.parse(await readFile(path, 'utf8')).amount).toBe(10)
  expect(JSON.parse(output.content)).toEqual({ amount: 20, keep: 'unchanged' })
  expect(output.originalUnchanged).toBe(true)
  expect(await resolveArtifact(join(root, 'outputs'), output.artifact)).toBe(output.path)
  expect(approvals).toBe(1)
})

it('refuses changed sources and malformed output without writing anything', async () => {
  const path = join(root, 'source.txt')
  await writeFile(path, 'before')
  const call = tools()
  const source = await call('file_read', { path })
  await writeFile(path, 'changed by user')
  await expect(call('file_create_copy', { name: 'copy.txt', sourcePath: path, expectedSha256: source.sha256, content: 'replacement' })).rejects.toThrow('revision')
  for (const name of ['../outside.txt', 'C:\\outside.txt', 'CON.txt', 'x.txt:secret', 'script.cmd']) {
    await expect(call('file_create_copy', { name, content: 'blocked' })).rejects.toThrow()
  }
  await expect(call('file_create_copy', { name: 'bad.json', content: '{invalid}' })).rejects.toThrow()
  expect(await readdir(root)).toEqual(['source.txt'])
})

it('does not repeat denied approval, and cancellation prevents output', async () => {
  const path = join(root, 'source.txt')
  await writeFile(path, 'private content')
  let approvals = 0
  const call = tools(async () => { approvals++; return false })
  await expect(call('file_read', { path })).rejects.toThrow('declined')
  await expect(call('file_read', { path })).rejects.toThrow('declined')
  expect(approvals).toBe(1)
  await expect(call('file_create_copy', { name: 'copy.txt', content: 'x' }, AbortSignal.abort())).rejects.toThrow()
  expect(await readdir(root)).toEqual(['source.txt'])
})

it('does not even resolve an unapproved source, including metadata-only revision attempts', async () => {
  const call = tools(async () => false)
  const path = join(root, 'not-present.txt')
  await expect(call('file_read', { path })).rejects.toThrow('declined')
  await expect(call('file_create_copy', { name: 'copy.txt', sourcePath: path, expectedSha256: '0'.repeat(64), content: 'x' })).rejects.toThrow('revision is missing')
  expect(await readdir(root)).toHaveLength(0)
})

it('paginates complete UTF-8 content and returns the same artifact for duplicate writes', async () => {
  const call = tools()
  const content = '한글,quoted\n'.repeat(3000)
  const result = await call('file_create_copy', { name: 'table.csv', content })
  expect(result.truncated).toBe(true)
  const tail = await call('file_read', { path: result.path, offset: result.nextOffset })
  expect(result.content + tail.content).toBe(content)
  const repeat = await call('file_create_copy', { name: 'table.csv', content })
  expect(repeat.artifact).toBe(result.artifact)
  expect(await readdir(join(root, 'outputs'))).toHaveLength(1)
})

it('rejects binary, oversized and path-escaping reads or artifact links', async () => {
  const call = tools()
  const path = join(root, 'data.txt')
  await writeFile(path, Buffer.from([0xff, 0xfe, 0]))
  await expect(call('file_read', { path })).rejects.toThrow()
  await writeFile(path, 'x'.repeat(512001))
  await expect(call('file_read', { path })).rejects.toThrow('512 KB')
  await expect(resolveArtifact(join(root, 'outputs'), '../secret.txt')).rejects.toThrow()
})

it.skipIf(process.platform === 'win32')('does not reveal a generated-name symlink outside the output folder', async () => {
  const out = join(root, 'outputs')
  await mkdir(out)
  const target = join(root, 'secret.txt')
  await writeFile(target, 'keep private')
  const id = '12345678-1234-1234-1234-123456789012-note.txt'
  await symlink(target, join(out, id))
  await expect(resolveArtifact(out, id)).rejects.toThrow('outside')
  const call = tools()
  const approved = join(root, 'approved.txt')
  await writeFile(approved, 'approved content')
  await call('file_read', { path: approved })
  await rm(approved)
  await symlink(target, approved)
  await expect(call('file_read', { path: approved })).rejects.toThrow('target changed')
})

it('creates a bulk workbook with literal strings and verified serialized formulas, not invented calculations', async () => {
  const tool = workbookTool(join(root, 'outputs'))
  const result = JSON.parse(await tool.run({ name: 'summary.xlsx', sheet: 'Summary', rows: [['Item', 'Count', 'Rate', 'Amount'], ['Alpha', 8, 1200, { formula: 'B2*C2' }], ['=literal', 3, 2500, { formula: 'B3*C3' }]] }, context))
  expect(result.rows[1]).toEqual(['Alpha', 8, 1200, { formula: 'B2*C2', calculatedValue: 'not verified' }])
  expect(result.rows[2][0]).toBe('=literal')
  expect(result.formulaCount).toBe(2)
  expect(result.verification).toContain('NOT verified')
  expect(await resolveArtifact(join(root, 'outputs'), result.artifact)).toBe(result.path)
})

it('refuses nonrectangular workbooks and external or executable formula features', async () => {
  const tool = workbookTool(join(root, 'outputs'))
  for (const rows of [[[1], [2, 3]], [[{ formula: 'WEBSERVICE("https://example.com")' }]], [[{ formula: 'HYPERLINK(A1)' }]], [[{ formula: '[other.xlsx]A1' }]], [[{ formula: 'cmd|anything' }]]]) {
    await expect(tool.run({ name: 'summary.xlsx', sheet: 'Summary', rows }, context)).rejects.toThrow()
  }
  expect(await readdir(root)).toHaveLength(0)
})

it('rejects CSV formula injection while preserving numeric negatives and quoted multiline values', async () => {
  const call = tools()
  for (const content of ['name,value\nitem,=1+2', 'name,value\nitem,"\t=HYPERLINK(A1)"', 'name,value\nitem,@SUM(A1)']) {
    await expect(call('file_create_copy', { name: 'unsafe.csv', content })).rejects.toThrow('formula-like')
  }
  const content = 'name,value\n"two\nlines",-123.45\n"a,b",+2'
  const result = await call('file_create_copy', { name: 'safe.csv', content })
  expect(result.content).toBe(content)
})

it('checks control again before saving and verifies all rows beyond the preview limit', async () => {
  const tool = workbookTool(join(root, 'outputs'), () => { throw new Error('Control stopped') })
  const args = { name: 'bulk.xlsx', sheet: 'Data', rows: Array.from({ length: 100 }, (_, index) => [index, index * 17]) }
  await expect(tool.run(args, context)).rejects.toThrow('Control stopped')
  expect(await readdir(root)).toHaveLength(0)
  const output = JSON.parse(await workbookTool(join(root, 'outputs')).run(args, context))
  expect(output.truncated).toBe(true)
  expect(output.rowCount).toBe(100)
  expect(output.completeReadback).toBe(true)
})
