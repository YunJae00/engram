import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { fileWorkTools, saveArtifact } from '../src/file-work.js'
import { readPackage } from '../src/document-package.js'
import { extractDocumentText } from '../src/capture/doc-extract.js'

let root: string
beforeEach(async () => { await mkdir('tmp', { recursive: true }); root = await mkdtemp(resolve('tmp/file-input-limits-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const context = { task: 'Read and submit saved documents.' }
function reader() {
  return fileWorkTools({ directory: join(root, 'outputs'), approveRead: async () => true }).find(tool => tool.name === 'file_read')!
}

it('reads an approved text file beyond the old input limit and preserves parentheses in output names', async () => {
  const path = join(root, 'large.txt')
  await writeFile(path, 'x'.repeat(600_000) + 'end')
  const tool = reader()
  const first = JSON.parse(await tool.run({ path }, context))
  expect(first.bytes).toBe(600_003)
  expect(first.nextOffset).toBe(24_000)
  expect(JSON.parse(await tool.run({ path, offset: 600_000 }, context)).content).toBe('end')
  const output = await saveArtifact(join(root, 'outputs'), 'report (final).txt', Buffer.from('Ready'))
  expect(await readFile(output.path, 'utf8')).toBe('Ready')
})

it('extracts the supplied document snapshot without reopening its path', async () => {
  const zip = new JSZip()
  zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Approved snapshot only.</w:t></w:r></w:p></w:body></w:document>')
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="main" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const path = join(root, 'missing.docx')
  expect(await extractDocumentText(path, { bytes, unbounded: true })).toBe('Approved snapshot only.')
  await writeFile(path, bytes)
  const read = JSON.parse(await reader().run({ path }, context))
  expect(read.content).toBe('Approved snapshot only.')
  zip.file('word/vbaProject.bin', 'macro')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer' }))
  await expect(reader().run({ path }, context)).rejects.toThrow('No readable text')
})

it('extracts every worksheet and pages beyond the capture preview limits', async () => {
  const XLSX = await import('xlsx')
  const book = XLSX.utils.book_new()
  for (let index = 0; index < 13; index++) XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['x'.repeat(9_000) + index]]), `Sheet${index}`)
  const path = join(root, 'many.xlsx')
  await writeFile(path, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
  const tool = reader()
  let content = '', offset: number | null = 0
  while (offset !== null) {
    const page = JSON.parse(await tool.run({ path, offset }, context))
    content += page.content
    offset = page.nextOffset
  }
  expect(content).toContain('## Sheet12')
  expect(content).toContain('x'.repeat(9_000) + '12')
  expect(content).not.toContain('(clipped)')
})

it('rejects huge sparse worksheet ranges without expanding empty cells', async () => {
  const XLSX = await import('xlsx')
  const book = XLSX.utils.book_new()
  const sheet = XLSX.utils.aoa_to_sheet([['one cell']])
  XLSX.utils.book_append_sheet(book, sheet, 'Data')
  const zip = await JSZip.loadAsync(XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
  const part = 'xl/worksheets/sheet1.xml'
  zip.file(part, (await zip.file(part)!.async('string')).replace('ref="A1"', 'ref="A1:XFD1048576"'))
  expect(await extractDocumentText(join(root, 'sparse.xlsx'), { bytes: await zip.generateAsync({ type: 'nodebuffer' }), unbounded: true })).toBeNull()
})

it('allows text-page offsets beyond the compressed input size limit', async () => {
  const zip = new JSZip()
  for (let index = 0; index < 3; index++) zip.file(`Contents/section${index}.xml`, `<text>${'x'.repeat(8_100_000)}</text>`)
  const path = join(root, 'expanded.hwpx')
  await writeFile(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))
  const page = JSON.parse(await reader().run({ path, offset: 20_000_000 }, context))
  expect(page.content).toHaveLength(24_000)
  expect(page.nextOffset).toBe(20_024_000)
})

it('refuses a hand-in through a junction that leaves the task directory', async () => {
  const work = join(root, 'work'), outside = join(root, 'outside')
  await mkdir(work)
  await mkdir(outside)
  await writeFile(join(outside, 'secret.txt'), 'Private')
  await symlink(outside, join(work, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  const tool = fileWorkTools({ directory: join(root, 'outputs'), approveRead: async () => false, handInRoots: [work] }).find(tool => tool.name === 'file_create_copy')!
  await expect(tool.run({ name: 'secret.txt', fromPath: join(work, 'linked', 'secret.txt') }, context)).rejects.toThrow('task folder')
})

it('refuses a hand-in whose parent becomes a junction during authorization', async () => {
  const work = join(root, 'work'), inner = join(work, 'inner'), outside = join(root, 'outside')
  await mkdir(inner, { recursive: true })
  await mkdir(outside)
  await writeFile(join(inner, 'note.txt'), 'Safe')
  await writeFile(join(outside, 'note.txt'), 'Private')
  const tool = fileWorkTools({
    directory: join(root, 'outputs'), handInRoots: [work], approveRead: async () => false,
    assertReadable: async () => {
      await rm(inner, { recursive: true })
      await symlink(outside, inner, process.platform === 'win32' ? 'junction' : 'dir')
    },
  }).find(tool => tool.name === 'file_create_copy')!
  await expect(tool.run({ name: 'note.txt', fromPath: join(inner, 'note.txt') }, context)).rejects.toThrow('target changed')
})

it('permits document outputs above eight megabytes but preserves the twenty megabyte limit', async () => {
  const output = await saveArtifact(join(root, 'outputs'), 'large.docx', Buffer.alloc(8_000_001))
  expect(output.bytes).toBe(8_000_001)
  await expect(saveArtifact(join(root, 'outputs'), 'too-large.docx', Buffer.alloc(20_000_001))).rejects.toThrow('size limit')
})

it('enforces the compressed and per-part limits before document parsing', async () => {
  await expect(readPackage(Buffer.alloc(20_000_001))).rejects.toThrow('Document exceeds 20 MB')
  const zip = new JSZip()
  zip.file('large.bin', Buffer.alloc(20_000_001))
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  await expect(readPackage(bytes)).rejects.toThrow('Document part exceeds 20 MB')
  expect(await extractDocumentText(join(root, 'large.hwpx'), { bytes, unbounded: true })).toBeNull()
})

it('enforces the total expansion limit even when every individual part fits', async () => {
  const zip = new JSZip(), part = Buffer.alloc(19_000_000)
  for (let index = 0; index < 7; index++) zip.file(`${index}.bin`, part)
  await expect(readPackage(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }))).rejects.toThrow('Expanded document exceeds 128 MB')
})
