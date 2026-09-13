import { describe, expect, it } from 'vitest'
import { t } from '../src/renderer/src/i18n.js'
import { pendingStatus, stepLabel, workBlocks, workLabel } from '../src/renderer/src/lib/pendingStatus.js'

describe('pendingStatus', () => {
  it('keeps narration between grouped tools without dropping their detailed record', () => {
    const lines = ['search_web: options', 'open_page: https://example.com', 'said: I found two useful sources.', 'read_open_page: details', 'said: I will compare the results.']
    expect(workBlocks(lines)).toEqual([
      { type: 'tools', lines: lines.slice(0, 2) }, { type: 'said', text: 'I found two useful sources.' },
      { type: 'tools', lines: [lines[3]] }, { type: 'said', text: 'I will compare the results.' },
    ])
    expect(workLabel('desktop_sequence: internal arguments')).toBe('Using the computer')
    expect(workLabel('some_new_tool: details')).toBe('Some new tool')
  })
  it('says the step the work is on', () => {
    expect(pendingStatus(t, 'search_web: lunch hours')).toBe('Searching the web for “lunch hours”')
  })
  it('falls back to the plain word before the first step', () => {
    expect(pendingStatus(t, undefined)).toBe('Thinking')
  })
})

describe('stepLabel', () => {
  it('leaves lines it does not recognise alone', () => {
    expect(stepLabel(t, '  <- search_memory: nothing in the vault')).toBe('  <- search_memory: nothing in the vault')
    expect(stepLabel(t, 'some_new_tool: arg')).toBe('some_new_tool: arg')
  })
})
