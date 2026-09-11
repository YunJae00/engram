import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import JSZip from 'jszip'
import { fileWorkTools, resolveArtifact } from '../src/file-work.js'
import { readPackage, validatePackage, hashBytes } from '../src/document-package.js'

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const relationships = (xml: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${xml}</Relationships>`
const relation = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`

let root: string
beforeEach(async () => { await mkdir('tmp', { recursive: true }); root = await mkdtemp(resolve('tmp/document-package-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
function caller(approveRead = async () => true, assertActive = () => {}) {
  const tools = fileWorkTools({ directory: join(root, 'outputs'), approveRead, assertActive })
  return async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => JSON.parse(await tools.find((tool) => tool.name === name)!.run(args, { task: 'Edit a separate document copy.', signal }))
}

async function fixture(extension: string, customize?: (zip: JSZip) => void) {
  const zip = new JSZip()
  const main = extension === 'docx' ? 'word/document.xml' : extension === 'pptx' ? 'ppt/presentation.xml' : 'xl/workbook.xml'
  const type = extension === 'docx' ? 'wordprocessingml.document' : extension === 'pptx' ? 'presentationml.presentation' : 'spreadsheetml.sheet'
  zip.file('[Content_Types].xml', `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/></Types>`)
  zip.file('_rels/.rels', relationships(relation('root', 'officeDocument', main)))
  let part = main
  if (extension === 'docx') zip.file(main, `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Draft proposal</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Keep this cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:sectPr/></w:body></w:document>`)
  if (extension === 'pptx') {
    zip.file(main, `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst><p:sldId id="256" r:id="slide"/></p:sldIdLst></p:presentation>`)
    zip.file('ppt/_rels/presentation.xml.rels', relationships(relation('slide', 'slide', 'slides/slide1.xml')))
    part = 'ppt/slides/slide1.xml'
    zip.file(part, `<p:sld xmlns:p="${P}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/></p:nvSpPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Draft proposal</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`)
  }
  if (extension === 'xlsx') {
    zip.file(main, `<workbook xmlns="${S}" xmlns:r="${R}"><sheets><sheet name="Data" sheetId="1" r:id="sheet"/></sheets></workbook>`)
    zip.file('xl/_rels/workbook.xml.rels', relationships(relation('sheet', 'worksheet', 'worksheets/sheet1.xml')))
    part = 'xl/worksheets/sheet1.xml'
    zip.file(part, `<worksheet xmlns="${S}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Draft proposal</t></is></c><c r="B1"><v>3</v></c><c r="C1"><v>2500</v></c><c r="D1"><f>B1*C1</f><v>7500</v></c></row></sheetData></worksheet>`)
  }
  zip.file('docProps/custom.xml', '<properties><value>Preserve original metadata</value></properties>')
  zip.file('media/image.png', Buffer.from([137, 80, 78, 71, 10, 0, 255]))
  customize?.(zip)
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  const path = join(root, `source.${extension}`)
  await writeFile(path, bytes)
  return { path, bytes, part }
}

it.each(['docx', 'pptx', 'xlsx'])('edits existing %s XML in one batch and preserves every unrelated part and the source', async (extension) => {
  const input = await fixture(extension)
  const call = caller()
  const before = await call('file_read_package', { path: input.path, part: input.part })
  const args = { sourcePath: before.path, expectedSha256: before.sha256, name: `revised.${extension}`, edits: [
    { part: input.part, expectedSha256: before.partSha256, before: 'Draft proposal', after: 'Reviewed proposal' },
    { part: input.part, expectedSha256: before.partSha256, before: 'Reviewed proposal', after: 'Final proposal' },
  ] }
  const output = await call('file_edit_package', args)
  expect(output.verification).toContain('NOT verified')
  expect(output.changedParts).toEqual([input.part])
  expect(await resolveArtifact(join(root, 'outputs'), output.artifact)).toBe(output.path)
  const original = await readPackage(input.bytes)
  const actual = await readPackage(await readFile(output.path))
  expect(actual.get(input.part)!.toString()).toContain('Final proposal')
  for (const [name, bytes] of original) if (name !== input.part) expect(actual.get(name)).toEqual(bytes)
  expect(await readFile(input.path)).toEqual(input.bytes)
  expect((await call('file_edit_package', args)).artifact).toBe(output.artifact)
  expect(await readdir(join(root, 'outputs'))).toHaveLength(1)
  const reread = await call('file_read_package', { path: output.path, part: input.part })
  expect(reread.xml).toContain('Final proposal')
  if (extension === 'docx') {
    const mammoth = await import('mammoth')
    expect((await mammoth.extractRawText({ buffer: await readFile(output.path) })).value).toContain('Final proposal')
  }
  if (extension === 'xlsx') {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(await readFile(output.path), { type: 'buffer' })
    expect(workbook.Sheets['Data']!['A1']!.v).toBe('Final proposal')
    expect(workbook.Sheets['Data']!['D1']!.f).toBe('B1*C1')
  }
})

it('rejects changed sources, stale parts and ambiguous replacements without any output', async () => {
  const input = await fixture('docx')
  const call = caller()
  const before = await call('file_read_package', { path: input.path, part: input.part })
  const args = { sourcePath: before.path, expectedSha256: before.sha256, name: 'copy.docx', edits: [{ part: input.part, expectedSha256: before.partSha256, before: '<w:p>', after: '<w:p/>' }] }
  await expect(call('file_edit_package', args)).rejects.toThrow('exactly once')
  args.edits[0]!.before = 'Draft proposal'
  args.edits[0]!.expectedSha256 = '0'.repeat(64)
  await expect(call('file_edit_package', args)).rejects.toThrow('revision')
  args.edits[0]!.expectedSha256 = before.partSha256
  await writeFile(input.path, 'changed')
  await expect(call('file_edit_package', args)).rejects.toThrow('revision')
  expect(await readdir(root)).toEqual(['source.docx'])
})

it.each(['<invalid>', '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///etc/passwd">]>&x;', '<w:r xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="missing"/>'])('rejects unsafe or broken XML before saving: %s', async (replacement) => {
  const input = await fixture('docx')
  const call = caller()
  const before = await call('file_read_package', { path: input.path, part: input.part })
  await expect(call('file_edit_package', { sourcePath: before.path, expectedSha256: before.sha256, name: 'copy.docx', edits: [{ part: input.part, expectedSha256: before.partSha256, before: '<w:t>Draft proposal</w:t>', after: replacement }] })).rejects.toThrow()
  expect(await readdir(root)).toEqual(['source.docx'])
})

it('refuses unapproved metadata reads and shares declined consent with text tools', async () => {
  let approvals = 0
  const call = caller(async () => { approvals++; return false })
  await expect(call('file_read_package', { path: join(root, 'missing.docx') })).rejects.toThrow('declined')
  await expect(call('file_read', { path: join(root, 'missing.txt') })).rejects.toThrow('declined')
  expect(approvals).toBe(1)
  const fresh = caller()
  await expect(fresh('file_edit_package', { sourcePath: join(root, 'missing.docx'), expectedSha256: '0'.repeat(64), name: 'copy.docx', edits: [{ part: 'word/document.xml', expectedSha256: '0'.repeat(64), before: 'x', after: 'y' }] })).rejects.toThrow('revision')
})

it('rejects traversal, duplicate parts, macros, oversized expansion and wrong document types', async () => {
  for (const customize of [
    (zip: JSZip) => { zip.file('../outside.xml', '<x/>') },
    (zip: JSZip) => { zip.file('WORD/document.xml', '<x/>') },
    (zip: JSZip) => { zip.file('word/vbaProject.bin', 'macro') },
    (zip: JSZip) => { zip.file('large.bin', Buffer.alloc(32_000_001)) },
  ]) {
    const input = await fixture('docx', customize)
    await expect(caller()('file_read_package', { path: input.path })).rejects.toThrow()
  }
  const input = await fixture('docx')
  expect(() => validatePackage(new Map(), '.docx')).toThrow()
  expect(() => validatePackage(new Map([['word/document.xml', Buffer.from('<x/>')]]), '.xlsx')).toThrow()
  await expect(caller()('file_read_package', { path: input.path }, AbortSignal.abort())).rejects.toThrow()
})

it('does not save when control is stopped, and rejects unsafe formula or external-link edits', async () => {
  const input = await fixture('xlsx')
  let stopped = false
  const call = caller(async () => true, () => { if (stopped) throw new Error('Control stopped') })
  const before = await call('file_read_package', { path: input.path, part: input.part })
  const args = { sourcePath: before.path, expectedSha256: before.sha256, name: 'copy.xlsx', edits: [{ part: input.part, expectedSha256: before.partSha256, before: 'B1*C1', after: 'WEBSERVICE(A1)' }] }
  await expect(call('file_edit_package', args)).rejects.toThrow('Unsupported formula')
  const rel = await call('file_read_package', { path: input.path, part: '_rels/.rels' })
  await expect(call('file_edit_package', { ...args, edits: [{ part: '_rels/.rels', expectedSha256: rel.partSha256, before: '</Relationships>', after: `<Relationship Id="external" Type="${R}/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>` }] })).rejects.toThrow('external links')
  stopped = true
  args.edits[0]!.after = 'B1+C1'
  await expect(call('file_edit_package', args)).rejects.toThrow('Control stopped')
  expect(await readdir(root)).toEqual(['source.xlsx'])
  expect(hashBytes(await readFile(input.path))).toBe(before.sha256)
})
