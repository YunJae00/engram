import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import JSZip from 'jszip'
import { fileWorkTools } from '../src/file-work.js'
import { readPackage } from '../src/document-package.js'

// grokbar cycle 7 (stack6-50519116) D5: one slide title took 45.1 s of 30, 28 s of it the model copying slide XML. The words of a deck are
// read as an outline and replaced by slide number, with no XML in either call.
const P = 'http://schemas.openxmlformats.org/presentationml/2006/main', A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const RUN = '<a:rPr lang="en-US" sz="2600" b="1" dirty="0"><a:solidFill><a:srgbClr val="1F3B5B"/></a:solidFill></a:rPr>'
const box = (id: number, lines: string[], run = '<a:rPr lang="en-US" sz="1300"/>') => `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Text ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${lines.map(line => `<a:p><a:r>${run}<a:t>${line}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`
const slide = (title: string, lines: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${box(2, [title], RUN)}${box(3, lines)}</p:spTree></p:cSld></p:sld>`
const SLIDES: [string, string[]][] = [['3분기 실적 보고', ['2026년 10월']], ['요약', ['매출: 수치 입력', '이익: 수치 입력']], ['주요 지표', ['매출 성장률', '신규 고객 수', '3 / 5']], ['과제', ['같은 줄', '같은 줄']], ['다음 단계', ['R&amp;D 일정']]]

let root: string
beforeEach(async () => { await mkdir('tmp', { recursive: true }); root = await mkdtemp(resolve('tmp/c7c-deck-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function deck() {
  const zip = new JSZip(), rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`
  const rels = (xml: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${xml}</Relationships>`
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
  zip.file('_rels/.rels', rels(rel('root', 'officeDocument', 'ppt/presentation.xml')))
  // The deck shows its slides in the order of the list, not of the file names: slide 3 is the third entry.
  zip.file('ppt/presentation.xml', `<p:presentation xmlns:p="${P}" xmlns:r="${R}"><p:sldIdLst>${SLIDES.map((_, at) => `<p:sldId id="${256 + at}" r:id="rId${at + 2}"/>`).join('')}</p:sldIdLst></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', rels(SLIDES.map((_, at) => rel(`rId${at + 2}`, 'slide', `slides/slide${at + 1}.xml`)).join('')))
  SLIDES.forEach(([title, lines], at) => zip.file(`ppt/slides/slide${at + 1}.xml`, slide(title, lines)))
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), path = join(root, '3분기 실적 보고.pptx')
  await writeFile(path, bytes)
  return { path, bytes }
}
const caller = (approveRead: (request: { path: string }) => Promise<boolean> = async () => true) => {
  const tools = fileWorkTools({ directory: join(root, 'outputs'), approveRead: approveRead as never })
  return async (name: string, args: Record<string, unknown>) => JSON.parse(await tools.find(tool => tool.name === name)!.run(args, { task: '3번 슬라이드 제목 바꿔줘' }))
}
const written = async () => readdir(join(root, 'outputs')).catch(() => [])

it('reads a deck as an outline: every slide with its number, title and texts, and no XML', async () => {
  const input = await deck(), call = caller()
  const outline = await call('file_read_package', { path: input.path, outline: true })
  expect(outline.slides).toEqual(SLIDES.map(([title, texts], at) => ({ slide: at + 1, title, texts: texts.map(text => text.replace('&amp;', '&')) })))
  expect(JSON.stringify(outline)).not.toContain('<a:')
  expect(JSON.stringify(outline).length).toBeLessThan(1000)
  expect(outline.sha256).toMatch(/^[a-f0-9]{64}$/)
})

it('replaces a slide title by slide number and words: one file, other parts byte-identical, the run kept, the text escaped', async () => {
  const input = await deck(), call = caller()
  const outline = await call('file_read_package', { path: input.path, outline: true })
  const output = await call('file_edit_package', { sourcePath: input.path, expectedSha256: outline.sha256, name: '3분기 실적 보고.pptx', edits: [{ slide: 3, with: '핵심 지표' }, { slide: 3, text: '매출 성장률', with: '매출 & 이익 <전년 대비>' }] })
  expect(output.changedParts).toEqual(['ppt/slides/slide3.xml'])
  expect(await written()).toHaveLength(1)
  const before = await readPackage(input.bytes), after = await readPackage(await readFile(output.path))
  for (const [name, bytes] of before) if (name !== 'ppt/slides/slide3.xml') expect(after.get(name), name).toEqual(bytes)
  const xml = after.get('ppt/slides/slide3.xml')!.toString()
  // Only the two texts differ: the title's run keeps its formatting, and the words are escaped.
  expect(xml).toBe(slide('핵심 지표', ['매출 &amp; 이익 &lt;전년 대비&gt;', '신규 고객 수', '3 / 5']))
  expect(xml).toContain(`${RUN}<a:t>핵심 지표</a:t>`)
  const again = await call('file_read_package', { path: output.path, outline: true })
  expect(again.slides[2]).toEqual({ slide: 3, title: '핵심 지표', texts: ['매출 & 이익 <전년 대비>', '신규 고객 수', '3 / 5'] })
  expect(await readFile(input.path)).toEqual(input.bytes)
})

it('refuses a text that is missing or there twice, a slide that is not there and a mixed batch, and writes nothing', async () => {
  const input = await deck(), call = caller()
  const outline = await call('file_read_package', { path: input.path, outline: true })
  const edit = (edits: unknown[]) => call('file_edit_package', { sourcePath: input.path, expectedSha256: outline.sha256, name: '3분기 실적 보고.pptx', edits })
  await expect(edit([{ slide: 3, text: '없는 줄', with: '새 줄' }])).rejects.toThrow(/no text that reads exactly.*Nothing was written/)
  await expect(edit([{ slide: 4, text: '같은 줄', with: '새 줄' }])).rejects.toThrow(/2 times.*Nothing was written/)
  await expect(edit([{ slide: 9, with: '새 제목' }])).rejects.toThrow(/5 slides.*Nothing was written/)
  // One good edit beside a bad one: the batch is refused whole.
  await expect(edit([{ slide: 3, with: '핵심 지표' }, { slide: 3, text: '없는 줄', with: '새 줄' }])).rejects.toThrow(/Nothing was written/)
  await expect(edit([{ slide: 3, with: '핵심 지표' }, { part: 'ppt/slides/slide1.xml', expectedSha256: 'a'.repeat(64), before: 'x', after: 'y' }])).rejects.toThrow(/slide edit/)
  await expect(edit([{ slide: 3, with: '<a:t>두\n줄</a:t>' }])).rejects.toThrow(/one line/)
  expect(await written()).toHaveLength(0)
  expect(await readFile(input.path)).toEqual(input.bytes)
})

it('goes through the same read gate as the XML form: a file the person did not open to it is refused, with nothing written', async () => {
  const input = await deck(), call = caller(async () => false)
  await expect(call('file_read_package', { path: input.path, outline: true })).rejects.toThrow()
  // No read in this session means no revision to edit from, whatever hash is offered.
  await expect(call('file_edit_package', { sourcePath: input.path, expectedSha256: 'a'.repeat(64), name: '3분기 실적 보고.pptx', edits: [{ slide: 3, with: '핵심 지표' }] })).rejects.toThrow()
  await expect(call('file_edit_package', { sourcePath: join(root, '..', 'elsewhere.pptx'), expectedSha256: 'a'.repeat(64), name: 'elsewhere.pptx', edits: [{ slide: 1, with: '핵심 지표' }] })).rejects.toThrow()
  expect(await written()).toHaveLength(0)
  expect(await readFile(input.path)).toEqual(input.bytes)
})

it('keeps outline and slide edits to decks', async () => {
  const input = await deck(), call = caller()
  const outline = await call('file_read_package', { path: input.path, outline: true })
  await expect(call('file_read_package', { path: input.path, outline: true, part: 'ppt/slides/slide3.xml' })).rejects.toThrow(/outline/)
  // The XML form still works on the same file, unchanged.
  const part = await call('file_read_package', { path: input.path, part: 'ppt/slides/slide3.xml' })
  const output = await call('file_edit_package', { sourcePath: input.path, expectedSha256: outline.sha256, name: 'copy.pptx', edits: [{ part: 'ppt/slides/slide3.xml', expectedSha256: part.partSha256, before: '<a:t>주요 지표</a:t>', after: '<a:t>핵심 지표</a:t>' }] })
  expect((await readPackage(await readFile(output.path))).get('ppt/slides/slide3.xml')!.toString()).toContain('핵심 지표')
})
