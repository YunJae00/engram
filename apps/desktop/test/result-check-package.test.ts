import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Document, Header, Packer, Paragraph } from 'docx'
import PptxGenJS from 'pptxgenjs'
import { fileWorkTools, type TurnStep } from 'core'
import { checkResult, resultCheckTool } from '../src/main/result-check.js'

let root: string
beforeEach(async () => { await mkdir('tmp', { recursive: true }); root = await mkdtemp(resolve('tmp/result-check-package-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function documentBytes(extension: string): Promise<Buffer> {
  const text = 'Draft proposal ' + 'Supporting text. '.repeat(1700)
  if (extension === 'docx') return Packer.toBuffer(new Document({ sections: [{
    headers: { default: new Header({ children: [new Paragraph('Review before sending.')] }) },
    children: [new Paragraph(text)],
  }] }))
  const slides = new PptxGenJS()
  slides.addSlide().addText(text, { x: 1, y: 1, w: 8, h: 4 }).addNotes('Review before sending.')
  return Buffer.from(await slides.write({ outputType: 'nodebuffer' }) as Buffer)
}

it.each(['docx', 'pptx'])('checks real %s copies from full content-part reads, not manifests or metadata', async extension => {
  const source = join(root, `source.${extension}`), directory = join(root, 'outputs')
  const bytes = await documentBytes(extension)
  await writeFile(source, bytes)
  const tools = fileWorkTools({ directory, approveRead: async path => path === source || path.startsWith(directory + '/') || path.startsWith(directory + '\\') })
  const call = async (tool: string, args: Record<string, unknown>): Promise<TurnStep> => ({
    tool, args, observation: await tools.find(candidate => candidate.name === tool)!.run(args, { task: 'Revise the separate document copy.' }),
  })
  const finding = { status: 'pass', basis: 'The requested revision matches the original document and all final text parts.' }
  const args = { checks: [{ requirement: 'Revise the proposal', ...finding }], grounding: finding }
  const report: TurnStep = { tool: 'report_result_check', args, observation: await resultCheckTool().run(args, { task: 'Check the result.' }) }
  const verify = (steps: TurnStep[]) => checkResult([...steps, report], [], [], true, directory)
  const manifest = await call('file_read_package', { path: source })
  const contentParts = JSON.parse(manifest.observation).textParts as string[]
  expect(contentParts.length).toBeGreaterThanOrEqual(2)
  expect(contentParts.every(part => !/docProps|styles|theme|\.rels$/.test(part))).toBe(true)
  const metadata = await call('file_read_package', { path: source, part: 'docProps/core.xml' })
  expect(verify([manifest, metadata]).issues.join(' ')).toContain('No usable source evidence')

  const main = extension === 'docx' ? 'word/document.xml' : 'ppt/slides/slide1.xml'
  const first = await call('file_read_package', { path: source, part: main })
  const initial = JSON.parse(first.observation)
  expect(initial.truncated).toBe(true)
  expect(initial.characters).toBeGreaterThan(initial.xml.length)
  expect(verify([manifest, metadata, first]).accepted).toBe(false)
  const readParts = async (path: string, parts: string[], firstOffsets: Record<string, number> = {}) => {
    const reads: TurnStep[] = []
    for (const part of parts) {
      let offset: number | null = firstOffsets[part] ?? 0
      do {
        const step = await call('file_read_package', { path, part, offset })
        reads.push(step)
        offset = JSON.parse(step.observation).nextOffset
      } while (offset !== null)
    }
    return reads
  }
  const sources = [manifest, ...await readParts(source, contentParts)]
  expect(verify(sources).accepted).toBe(true)
  const made = await call('file_edit_package', { sourcePath: source, expectedSha256: initial.sha256, name: `revised.${extension}`,
    edits: [{ part: main, expectedSha256: initial.partSha256, before: 'Draft proposal', after: 'Final proposal' }] })
  const output = JSON.parse(made.observation)
  const outputManifest = await call('file_read_package', { path: output.path })
  expect(verify([...sources, made, outputManifest]).accepted).toBe(false)
  const partial = await call('file_read_package', { path: output.path, part: main })
  const others = await readParts(output.path, contentParts.filter(part => part !== main))
  expect(verify([...sources, made, partial, ...others]).accepted).toBe(false)
  const rest = await readParts(output.path, [main], { [main]: JSON.parse(partial.observation).nextOffset })
  const finalReads = [partial, ...others, ...rest]
  expect(verify([...sources, made, ...finalReads])).toEqual({ accepted: true, verified: true, issues: [] })
  expect(verify([...sources, ...finalReads, made]).accepted).toBe(false)
  expect(verify([...sources, made, ...finalReads.map(step => ({ ...step, seeded: true }))]).accepted).toBe(false)
  const changed = { ...partial, observation: JSON.stringify({ ...JSON.parse(partial.observation), sha256: 'b'.repeat(64) }) }
  expect(verify([...sources, made, changed, ...others, ...rest]).accepted).toBe(false)
  const gap = { ...partial, observation: JSON.stringify({ ...JSON.parse(partial.observation), nextOffset: 1 }) }
  expect(verify([...sources, made, gap, ...others, ...rest]).accepted).toBe(false)
  expect(await readFile(source)).toEqual(bytes)
})

// c7c round 2 (Codex r1): a slide's words are changed through the outline with no XML, and the check of that deck has to be the outline too,
// or the XML read the change removed comes back in the check turn. The outline counts only when the host marked it the whole deck.
it('checks a deck changed by slide number from one outline read, with no XML part read', async () => {
  const source = join(root, 'deck.pptx'), directory = join(root, 'outputs')
  const slides = new PptxGenJS()
  slides.addSlide().addText('3분기 실적 보고', { x: 1, y: 1, w: 8, h: 1 }).addText('매출: 수치 입력', { x: 1, y: 2, w: 8, h: 1 })
    .addChart('bar', [{ name: '매출', labels: ['7월', '8월'], values: [2447, 3402] }], { x: 1, y: 3, w: 4, h: 2 }).addNotes('발표 전 확인')
  await writeFile(source, Buffer.from(await slides.write({ outputType: 'nodebuffer' }) as Buffer))
  const tools = fileWorkTools({ directory, approveRead: async () => true })
  const call = async (tool: string, args: Record<string, unknown>): Promise<TurnStep> => ({
    tool, args, observation: await tools.find(candidate => candidate.name === tool)!.run(args, { task: '1번 슬라이드 제목 바꿔줘' }),
  })
  const finding = { status: 'pass', basis: 'Slide 1 reads the new title in the outline of the saved deck.' }
  const args = { checks: [{ requirement: 'Change the title of slide 1', ...finding }], grounding: finding }
  const report: TurnStep = { tool: 'report_result_check', args, observation: await resultCheckTool().run(args, { task: 'Check the result.' }) }
  const verify = (steps: TurnStep[]) => checkResult([...steps, report], [], [], true, directory)

  const before = await call('file_read_package', { path: source, outline: true })
  const read = JSON.parse(before.observation)
  expect(read.completeReadback).toBe(true)
  expect(read.slides[0].title).toBe('3분기 실적 보고')
  expect(JSON.stringify(read.otherTexts)).toContain('발표 전 확인')
  // Most decks the team builds hold a chart: its labels and values are in the outline too, so it is still the whole deck.
  expect(JSON.stringify(read.otherTexts)).toContain('"7월","8월"')
  expect(JSON.stringify(read.otherTexts)).toContain('3402')
  expect(before.observation).not.toContain('<a:')
  const made = await call('file_edit_package', { sourcePath: source, expectedSha256: read.sha256, name: 'deck.pptx', edits: [{ slide: 1, with: '3분기 실적 요약' }] })
  // The read from before the write is not the readback of what was written.
  expect(verify([before, made]).accepted).toBe(false)
  const after = await call('file_read_package', { path: JSON.parse(made.observation).path, outline: true })
  expect(JSON.parse(after.observation).slides[0].title).toBe('3분기 실적 요약')
  expect(verify([before, made, after])).toEqual({ accepted: true, verified: true, issues: [] })
  expect(verify([before, made, { ...after, seeded: true }]).accepted).toBe(false)
  // An outline the host did not mark complete (text it cannot show, e.g. a chart's values) proves nothing: the parts are read as before.
  const partly = JSON.parse(after.observation) as Record<string, unknown>
  delete partly['completeReadback']
  expect(verify([before, made, { ...after, observation: JSON.stringify(partly) }]).accepted).toBe(false)
  expect(verify([made, after]).issues.join(' ')).not.toContain('Reread every final part')
})
