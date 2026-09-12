import { expect, it } from 'vitest'
import { checkOfficeResult, officeWriteUnverified } from '../src/office-verification.js'
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
  const written = step('excel_write', { ...target, written: 2 }, { cells: [{ cell: 'A1', value: 1 }, { cell: 'C2', value: 2 }], formats: [{ range: 'A1:B1', bold: true }] })
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
  expect(result.answer).toContain('Not verified as complete')
  const asked = { steps, answer: 'Continue?', fellBack: false, asked: true }
  expect(checkOfficeResult(asked)).toBe(asked)
  expect(checkOfficeResult(result)).toBe(result)
})
