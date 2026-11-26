import { expect, it } from 'vitest'
import { checkOfficeResult, OFFICE_CLOSED, officeWriteUnverified } from '../src/office-verification.js'
import type { AgentLoopStep } from '../src/agent-loop.js'

const step = (tool: string, result: unknown, args: Record<string, unknown> = {}): AgentLoopStep => ({ tool, args, observation: typeof result === 'string' ? result : JSON.stringify(result) })
const write = (file = 'C:/a.pptx') => step('ppt_build', { saved: file })
const read = (file = 'C:/a.pptx') => step('ppt_read', { file, revision: 'a'.repeat(32), content: [{ text: 'Actual text' }] })

it.each([
  [], [read('C:/other.pptx')], [step('word_read', { file: 'C:/a.pptx', revision: 'a'.repeat(32), content: [] })],
  [step('ppt_read', 'that did not work: unavailable')], [step('ppt_read', { error: 'unavailable' })],
  [step('ppt_read', { file: 'C:/a.pptx', revision: 'a'.repeat(32), content: [], truncated: true })],
  [step('ppt_read', { file: 'C:/a.pptx' })],
].map(reads => ({ reads })))('does not accept absent, unrelated or unsuccessful reads ($reads)', ({ reads }) => {
  expect(officeWriteUnverified([write(), ...reads])).toBeDefined()
})

it('requires each document after its last write, matching normalized paths', () => {
  expect(officeWriteUnverified([read(), write()])).toBeDefined()
  expect(officeWriteUnverified([write(), read(), write()])).toBeDefined()
  expect(officeWriteUnverified([write(), write('C:/b.pptx'), read('C:/b.pptx')])).toBeDefined()
  expect(officeWriteUnverified([write(), write('C:/b.pptx'), read('C:/b.pptx'), read('c:\\A.pptx')])).toBeUndefined()
})

it.each(['ppt', 'word'])('uses the resulting save-as target for %s edits', app => {
  const written = step(`${app}_edit`, { file: `C:/new.${app}x`, applied: 1 }, { file: `C:/old.${app}x` })
  const old = step(`${app}_read`, { file: `C:/old.${app}x`, revision: 'a'.repeat(32), content: [] })
  const current = step(`${app}_read`, { file: `C:/new.${app}x`, revision: 'b'.repeat(32), content: [] })
  expect(officeWriteUnverified([written, old])).toBeDefined()
  expect(officeWriteUnverified([written, current])).toBeUndefined()
})

it('requires fresh read coverage for all changed cells, sheets and workbooks', () => {
  const target = { workbook: 'Book1', sheet: 'Sales' }
  const written = step('excel_write', { ...target, written: 2 }, { cells: [{ cell: 'A1', value: 1 }, { cell: ' C2 ', value: 2 }], formats: [{ range: ' A1:B1 ', bold: true }] })
  const first = step('excel_read', { ...target, range: 'A1:B1', rows: [[1, null]] })
  const last = step('excel_read', { ...target, range: 'C2', rows: [[2]] })
  expect(officeWriteUnverified([written, first])).toBeDefined()
  expect(officeWriteUnverified([written, first, step('excel_read', { ...target, sheet: 'Other', range: 'C2', rows: [[2]] })])).toBeDefined()
  expect(officeWriteUnverified([written, first, step('excel_read', { ...target, workbook: 'Book2', range: 'C2', rows: [[2]] })])).toBeDefined()
  expect(officeWriteUnverified([written, first, last])).toBeUndefined()
  expect(officeWriteUnverified([written, first, last, written, last])).toBeDefined()
})

it('keeps failed writes incomplete and preserves explicit questions without claiming success', () => {
  const steps = [step('word_write', 'that did not work: partial write')]
  const result = checkOfficeResult({ steps, answer: 'Done', fellBack: false })
  expect(result.incomplete).toBeDefined()
  expect(result.answer).toBe('Done')
  const asked = { steps, answer: 'Continue?', fellBack: false, asked: true }
  expect(checkOfficeResult(asked)).toBe(asked)
  expect(checkOfficeResult(result)).toBe(result)
})

it('takes a composed file the host saved and compared as read back, and a command refused for a closed application as no write', () => {
  const composed = { artifact: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-a.docx', path: '/out/a.docx', sha256: 'a'.repeat(64), completeReadback: true }
  expect(officeWriteUnverified([step('word_write', composed), step('ppt_build', composed)])).toBeUndefined()
  expect(officeWriteUnverified([step('word_write', { ...composed, completeReadback: false })])).toBeDefined()
  expect(officeWriteUnverified([step('word_write', { path: '/out/a.docx' })])).toBeDefined()
  expect(officeWriteUnverified([step('excel_write', `that did not work: ${OFFICE_CLOSED}`)])).toBeUndefined()
  expect(officeWriteUnverified([write(), step('excel_write', `that did not work: ${OFFICE_CLOSED}`)])).toBeDefined()
})

const refused = 'The deck does not read clean yet:\nslide 3 · overflow: Body exceeds the slide area. Split bullets, table rows or chart across slides.\nFix these and build it again.'
const built = { artifact: '88fbfdc4-fef2-eba9-2eb0-787472208689-3분기 실적 보고 (2026-11-23).pptx', path: '/out/deck.pptx', sha256: 'a'.repeat(64), completeReadback: true }
it('does not count a refused build as a write, and lets a later complete read-back clear an earlier unknown write of the same builder', async () => {
  const { describeDeckFindings } = await import('../src/deck-audit.js')
  expect(describeDeckFindings([{ slide: 3, kind: 'overflow', text: 'Body exceeds the slide area.' }] as never).startsWith('The deck does not read clean yet')).toBe(true)
  expect(officeWriteUnverified([step('ppt_build', refused)])).toBeUndefined()
  expect(officeWriteUnverified([step('ppt_build', refused), step('ppt_build', built)])).toBeUndefined()
  const result = checkOfficeResult({ steps: [step('ppt_build', refused), step('ppt_build', built)], answer: 'PPT 5장 만들었어요.', fellBack: false })
  expect(result.incomplete).toBeUndefined()
  expect(result.answer).toBe('PPT 5장 만들었어요.')
  const unknown = step('ppt_build', { path: '/out/deck.pptx' })
  expect(officeWriteUnverified([unknown])).toBeDefined()
  expect(officeWriteUnverified([unknown, step('ppt_build', built)])).toBeUndefined()
  expect(officeWriteUnverified([unknown, step('word_write', built)])).toBeDefined()
  expect(officeWriteUnverified([step('ppt_build', built), unknown])).toBeDefined()
  expect(officeWriteUnverified([step('word_write', 'that did not work: partial write')])).toBeDefined()
  expect(officeWriteUnverified([write(), step('ppt_build', refused)])).toBeDefined()
})

it('clears an unknown write only by a complete read-back of the same file', () => {
  const failed = (saveAs?: string) => step('ppt_build', 'that did not work: partial write', saveAs ? { slides: [], saveAs } : { slides: [] })
  const good = (saveAs: string, path = `/out/${saveAs}`) => step('ppt_build', { ...built, path }, { slides: [], saveAs })
  expect(officeWriteUnverified([failed('a.pptx'), good('b.pptx')])).toBeDefined()
  expect(officeWriteUnverified([failed('a.pptx'), good('a.pptx')])).toBeUndefined()
  expect(officeWriteUnverified([failed('A.pptx'), good('a.pptx')])).toBeUndefined()
  expect(officeWriteUnverified([failed('a.pptx'), failed('b.pptx'), good('b.pptx')])).toBeDefined()
  expect(officeWriteUnverified([failed('a.pptx'), failed('b.pptx'), good('b.pptx'), good('a.pptx')])).toBeUndefined()
  expect(officeWriteUnverified([step('ppt_build', { path: '/out/a.pptx' }), good('b.pptx')])).toBeDefined()
  expect(officeWriteUnverified([step('ppt_build', { path: '/out/a.pptx' }), good('x.pptx', '/out/a.pptx')])).toBeUndefined()
  expect(officeWriteUnverified([failed('a.pptx'), good('a.pptx', '/out/a-2.pptx')])).toBeDefined()
  expect(officeWriteUnverified([step('ppt_build', { path: '/out/a.pptx' }), good('a.pptx', '/other/a.pptx')])).toBeDefined()
  expect(officeWriteUnverified([failed('a'), good('a', '/out/a.pptx')])).toBeUndefined()
  expect(officeWriteUnverified([failed(), good('b.pptx')])).toBeDefined()
  expect(officeWriteUnverified([failed(), step('ppt_build', built)])).toBeDefined()
})
