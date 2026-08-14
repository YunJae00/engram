import { describe, expect, it } from 'vitest'
import { J8_INSTRUCTION } from '../src/jobs/librarian.js'

describe('the brief lists work, not the notes it came from', () => {
  it('merges one job that is spread across several notes', () => {
    expect(J8_INSTRUCTION).toContain('fold it into ONE line')
    expect(J8_INSTRUCTION).toContain('Do not mechanically emit a line per note')
    expect(J8_INSTRUCTION).toContain('a list of things to do, not a list of notes')
  })

  it('still leaves exactly one startable action on the line', () => {
    expect(J8_INSTRUCTION).toContain('exactly one startable action')
    expect(J8_INSTRUCTION).toContain('Never chain two')
    expect(J8_INSTRUCTION).toContain('write only the first one and stop')
  })

  it('labels the line with the job, not the note title it was copied from', () => {
    expect(J8_INSTRUCTION).toContain('not a copy of the note title')
    expect(J8_INSTRUCTION).not.toContain('<title from loops>')
    expect(J8_INSTRUCTION).toContain('<name of the piece of work>')
  })
})

describe('the brief gives instructions, not a status report', () => {
  it('demands actions rather than descriptions of finished work', () => {
    expect(J8_INSTRUCTION).toContain('an instruction, not a report')
    expect(J8_INSTRUCTION).toContain('end them with the action to take')
  })

  it('rejects lines that merely restate the title', () => {
    expect(J8_INSTRUCTION).toContain('Restating the title is not an answer')
    for (const banned of ['still incomplete', 'needs review']) {
      expect(J8_INSTRUCTION).toContain(banned)
    }
  })
})

describe('the brief speaks the language of the vault', () => {
  it('keeps the section headings in English but the content in the notes language', () => {
    expect(J8_INSTRUCTION).toContain('Keep the three section headings in English')
    expect(J8_INSTRUCTION).toContain('the language of the vault notes')
  })
})
