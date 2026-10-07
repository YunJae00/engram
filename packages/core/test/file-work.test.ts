import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileWorkTools, resolveArtifact, saveArtifact } from '../src/file-work.js'
import { workbookTool } from '../src/file-workbook.js'
import { workCapabilities } from '../src/work-capabilities.js'

let root: string
beforeEach(async () => { await mkdir('tmp', { recursive: true }); root = await mkdtemp(resolve('tmp/file-work-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const context = { task: 'Create a revised copy, preserving the source.' }
function tools(approveRead = async () => true) {
  const all = fileWorkTools({ directory: join(root, 'outputs'), approveRead })
  return async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => JSON.parse(await all.find((tool) => tool.name === name)!.run(args, { ...context, signal }))
}

it('reports measured words, characters and lines for a saved text file', async () => {
  const output = await tools()('file_create_copy', { name: 'email.txt', content: 'UNSENT\nTo: the team\n\nThree  more\twords here.\n' })
  expect(output).toMatchObject({ words: 8, characters: 45, lines: 5 })
  expect((await tools()('file_create_copy', { name: 'empty.txt', content: '' })).words).toBe(0)
})

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
  await expect(call('file_create_copy', { name: 'copy.txt', sourcePath: path, expectedSha256: '0'.repeat(64), content: 'x' })).rejects.toThrow('declined')
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

it('creates multiple sheets with local cross-sheet formulas while rejecting unknown or external targets', async () => {
  const tool = workbookTool(join(root, 'outputs'))
  const sheets = [{ sheet: 'Summary', rows: [[{ formula: "SUM('Prepaid Expenses'!A1:A2)" }]] }, { sheet: 'Prepaid Expenses', rows: [[12], [18]] }]
  const result = JSON.parse(await tool.run({ name: 'linked.xlsx', sheets }, context))
  expect(result.sheets.map((sheet: { sheet: string }) => sheet.sheet)).toEqual(['Summary', 'Prepaid Expenses'])
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await readFile(result.path), { type: 'buffer', sheetStubs: true })
  expect(workbook.SheetNames).toEqual(['Summary', 'Prepaid Expenses'])
  expect(workbook.Sheets.Summary!.A1.f).toBe("SUM('PREPAID EXPENSES'!A1:A2)")
  for (const formula of ["'Missing'!A1", "'[external.xlsx]Prepaid Expenses'!A1", "WEBSERVICE('Prepaid Expenses'!A1)"]) {
    await expect(tool.run({ name: 'bad.xlsx', sheets: [{ sheet: 'Summary', rows: [[{ formula }]] }, sheets[1]] }, context)).rejects.toThrow()
  }
  await expect(tool.run({ name: 'bad.xlsx', sheets: [sheets[1], sheets[1]] }, context)).rejects.toThrow()
  await expect(tool.run({ name: 'bad.xlsx', sheets, sheet: 'Extra', rows: [[1]] }, context)).rejects.toThrow()
})

it('rejects CSV formula injection while preserving numeric negatives and quoted multiline values', async () => {
  const call = tools()
  for (const content of ['name,value\nitem,=1+2', 'name,value\nitem,"\t=HYPERLINK(A1)"', 'name,value\nitem,@SUM(A1)', 'sep=;\nname;value\nitem;=1+2', 'name;value\nitem;=1+2']) {
    await expect(call('file_create_copy', { name: 'unsafe.csv', content })).rejects.toThrow('formula-like')
  }
  const content = 'name,value\n"two\nlines",-123.45\n"a,b",+2'
  const result = await call('file_create_copy', { name: 'safe.csv', content })
  expect(result.content).toBe(content)
})

it.each(['table.csv', 'table.CSV', 'table.tsv', 'table.TSV'])('preserves quoted delimiters, quotes, multiline cells, BOM and CRLF in %s', async (name) => {
  const delimiter = name.toLowerCase().endsWith('.tsv') ? '\t' : ','
  const content = `\uFEFFname${delimiter}note${delimiter}value\r\n한글${delimiter}"contains${delimiter}separator ""quoted""\r\nnext line"${delimiter}-12.5\r\nempty${delimiter}${delimiter}\r\n`
  const call = tools()
  const output = await call('file_create_copy', { name, content })
  expect(await readFile(output.path, 'utf8')).toBe(content)
  expect(output.tableValidation).toEqual({ valid: true, format: name.slice(-3).toLowerCase(), rows: 3, columns: 3 })
  expect((await call('file_read', { path: output.path })).tableValidation).toEqual(output.tableValidation)
})

it.each([
  ['table.csv', 'id,reason,status\nA1,Waiting,verified\nA2,Still waiting, incoming tomorrow,verified\n', 3, 4, 'Expected 3 columns but found 4'],
  ['table.csv', 'a,b,c\n1,2\n', 2, 3, 'Expected 3 columns but found 2'],
  ['table.tsv', 'a\tb\n1\t2\t\n', 2, 3, 'Expected 2 columns but found 3'],
  ['table.csv', 'a,b\n1,un"quoted\n', 2, 2, 'Unexpected quote'],
  ['table.tsv', 'a\tb\n1\t"unterminated\nnext line', 2, 2, 'Unclosed quoted cell'],
  ['table.csv', 'a,b\n1,"quoted"suffix\n', 2, 2, 'Unexpected text after a closing quote'],
  ['table.csv', 'a,b\n1,"first\nsecond"\n\n', 3, 2, 'Expected 2 columns but found 1'],
])('rejects malformed %s before saving and identifies the logical row and column', async (name, content, row, column, reason) => {
  const call = tools()
  await expect(call('file_create_copy', { name, content })).rejects.toThrow(`row ${row}, column ${column}: ${reason}`)
  expect(await readdir(root)).toEqual([])
})

it('also validates direct artifact saves, without creating an artifact or receipt for malformed tables', async () => {
  await expect(saveArtifact(join(root, 'outputs'), 'bad.csv', Buffer.from('a,b\n1,2,3'))).rejects.toThrow('row 2, column 3')
  await expect(saveArtifact(join(root, 'outputs'), 'unsafe.TSV', Buffer.from('a\tb\n1\t"\t=1+2"'))).rejects.toThrow('formula-like')
  expect(await readdir(root)).toEqual([])
})

it('keeps malformed input readable for repair and validates beyond the displayed page', async () => {
  const path = join(root, 'source.csv')
  const content = 'id,note\n' + 'item,waiting\n'.repeat(3000) + 'last,waiting, incoming tomorrow\n'
  await writeFile(path, content)
  const call = tools()
  const source = await call('file_read', { path })
  expect(source.truncated).toBe(true)
  expect(source.content).not.toContain('incoming tomorrow')
  expect(source.tableValidation).toMatchObject({ valid: false, columns: 2, error: { row: 3002, column: 3, message: expect.stringContaining('found 3') } })
  const corrected = content.replace('last,waiting, incoming tomorrow', 'last,"waiting, incoming tomorrow"')
  const output = await call('file_create_copy', { name: 'repaired.csv', content: corrected, sourcePath: path, expectedSha256: source.sha256 })
  expect(output.tableValidation).toEqual({ format: 'csv', valid: true, rows: 3002, columns: 2 })
  expect(await readFile(path, 'utf8')).toBe(content)
})

it('reports invalid quotes on read without hiding or silently changing the source', async () => {
  const path = join(root, 'source.tsv')
  const content = 'id\tnote\n1\t"unfinished'
  await writeFile(path, content)
  const source = await tools()('file_read', { path })
  expect(source.content).toBe(content)
  expect(source.tableValidation).toMatchObject({ valid: false, error: { row: 2, column: 2, message: expect.stringContaining('Unclosed') } })
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

it('find_files returns name/path candidates only when a finder is available, and is absent otherwise', async () => {
  const seen: string[] = []
  const withFinder = fileWorkTools({
    directory: join(root, 'outputs'),
    approveRead: async () => true,
    findFiles: async (query) => { seen.push(query); return { matches: query.includes('budget') ? [{ path: join(root, 'Q3 budget.xlsx'), name: 'Q3 budget.xlsx', folder: root, modified: '2026-09-01T00:00:00.000Z' }] : [], limited: false } },
  })
  const find = withFinder.find((tool) => tool.name === 'find_files')!
  const methods = JSON.parse(await workCapabilities(withFinder).run({}, context))
  expect(methods.savedFiles.map((tool: { name: string }) => tool.name)).toContain('find_files')
  const hit = JSON.parse(await find.run({ query: 'budget' }, { task: 'find it' }))
  expect(seen).toEqual(['budget'])
  expect(hit.matches).toHaveLength(1)
  expect(hit.matches[0].name).toBe('Q3 budget.xlsx')
  // No content is ever returned by a look — only paths and names.
  expect(JSON.stringify(hit)).not.toContain('content')
  const miss = JSON.parse(await find.run({ query: 'nowhere' }, { task: 'find it' }))
  expect(miss.matches).toEqual([])
  await expect(find.run({ query: '' }, { task: 'find it' })).rejects.toThrow()
  await expect(find.run({ query: 'x'.repeat(121) }, { task: 'find it' })).rejects.toThrow()
  // Without a finder dependency the tool is not offered at all.
  expect(fileWorkTools({ directory: join(root, 'outputs'), approveRead: async () => true }).some((tool) => tool.name === 'find_files')).toBe(false)
})
