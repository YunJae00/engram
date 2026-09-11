import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => ({ directory: '', open: vi.fn(async () => '') }))
vi.mock('electron', () => ({ app: { getPath: () => fake.directory }, shell: { openPath: fake.open } }))
import { renderDeck } from '../src/main/deck-render.js'
import { renderDoc } from '../src/main/doc-render.js'
import { resolveTheme } from 'core'

// The renderers hold no look of their own; the caller supplies one.
const THEME = resolveTheme({ field: '1F3B5B', accent: 'C0603B', fonts: { title: 'Georgia', body: 'Segoe UI' } })!

const require = createRequire(resolve('packages/core/package.json'))
const JSZip = require('jszip') as typeof import('../../../packages/core/node_modules/jszip')

beforeEach(async () => {
  await mkdir(resolve('tmp'), { recursive: true })
  fake.directory = await mkdtemp(resolve('tmp/office-render-'))
  fake.open.mockClear()
})
afterEach(async () => { await rm(fake.directory, { recursive: true, force: true }) })

it('writes real Office packages, protects existing documents and reports open failures', async () => {
  const path = join(fake.directory, 'result.docx')
  await renderDoc({ blocks: [{ kind: 'paragraph', text: 'Preserve this document' }], saveAs: path, theme: THEME }, false)
  const original = await readFile(path)
  const zip = await JSZip.loadAsync(original)
  expect(await zip.file('word/document.xml')!.async('string')).toContain('Preserve this document')
  await expect(renderDoc({ blocks: [{ kind: 'paragraph', text: 'replacement' }], saveAs: path, theme: THEME }, false)).rejects.toMatchObject({ code: 'EEXIST' })
  expect(await readFile(path)).toEqual(original)
  fake.open.mockResolvedValueOnce('Application unavailable')
  await expect(renderDoc({ blocks: [{ kind: 'paragraph', text: 'New document' }], theme: THEME })).rejects.toThrow('but opening failed')
})

it('allocates a larger bullet box and rejects overflowing tables without creating files', async () => {
  const result = await renderDeck({ slides: [{ title: 'Steps', bullets: Array(7).fill('One short point') }], theme: THEME }, false)
  const zip = await JSZip.loadAsync(await readFile(result.path))
  const xml = await zip.file('ppt/slides/slide1.xml')!.async('string')
  expect(xml.match(/One short point/g)).toHaveLength(7)
  // Seven points receive 3.22 inches instead of the old 1.3-inch text box.
  expect(xml).toContain('cy="2944368"')
  const before = await readdir(join(fake.directory, 'Engram'))
  await expect(renderDeck({ slides: [{ title: 'Rows', table: { rows: Array.from({ length: 30 }, () => ['Item', 1]) } }], theme: THEME }, false)).rejects.toThrow('slide area')
  expect(await readdir(join(fake.directory, 'Engram'))).toEqual(before)
})

it('renders in the brand the caller passes, not a look of its own', async () => {
  // Two unrelated brands; each file must carry its own colours and neither the
  // other's - proof the design is data the caller supplies, not baked in here.
  const brand = resolveTheme({ field: '7A1F3B', accent: '2FA98C', fonts: { title: 'Cambria', body: 'Verdana' } })!
  const deck = await renderDeck({ slides: [{ title: 'Plan', subtitle: 'Q4' }, { title: 'Steps', bullets: ['Ship', 'Measure'] }], theme: brand, saveAs: join(fake.directory, 'branded.pptx') }, false)
  const deckZip = await JSZip.loadAsync(await readFile(deck.path))
  const slideXml = await deckZip.file('ppt/slides/slide1.xml')!.async('string') + await deckZip.file('ppt/slides/slide2.xml')!.async('string')
  expect(slideXml).toContain('7A1F3B')
  expect(slideXml).toContain('2FA98C')
  expect(slideXml).not.toContain('1F3B5B')
  const docResult = await renderDoc({ blocks: [{ kind: 'title', text: 'Report' }, { kind: 'table', table: { rows: [['A', 'B'], ['1', '2']] } }], theme: brand, saveAs: join(fake.directory, 'branded.docx') }, false)
  const docXml = await (await JSZip.loadAsync(await readFile(docResult.path))).file('word/document.xml')!.async('string')
  expect(docXml).toContain('7A1F3B')
  expect(docXml).toContain('Verdana')
  expect(docXml).not.toContain('1F3B5B')
})

it('does not save or open when a render was cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  const path = join(fake.directory, 'cancelled.pptx')
  await expect(renderDeck({ slides: [{ title: 'Cancelled' }], saveAs: path, theme: THEME }, true, controller.signal)).rejects.toThrow()
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(fake.open).not.toHaveBeenCalled()
})
