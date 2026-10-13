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

describe('plain words for the runtime and file tools', () => {
  it('names what is being done with a file, a pattern or a command', () => {
    expect(stepLabel(t, 'Read: C:/Users/me/Desktop/report.xlsx')).toBe('Reading report.xlsx')
    expect(stepLabel(t, String.raw`Read: C:\Users\me\Desktop\report.xlsx`)).toBe('Reading report.xlsx')
    expect(stepLabel(t, 'Glob: *agent*')).toBe('Looking for files (*agent*)')
    expect(stepLabel(t, 'Grep: total')).toBe('Searching files for “total”')
    expect(stepLabel(t, 'PowerShell: python make_xlsx.py')).toBe('Running a command (python make_xlsx.py)')
    expect(stepLabel(t, 'Write: C:/work/bot-1/parse.py')).toBe('Writing parse.py')
    expect(stepLabel(t, 'file_read: saved file')).toBe('Reading a saved file')
    expect(stepLabel(t, 'file_create_workbook: 부서별_매출_합계.xlsx')).toBe('Saving 부서별_매출_합계.xlsx')
    expect(stepLabel(t, 'note: Checking the result against your request')).toBe('Checking the result against your request')
    expect(stepLabel(t, 'report_result_check: ')).toBe('Reporting the check')
  })
  it('groups them under what the person sees as one kind of work', () => {
    expect(workLabel('Glob: *agent*')).toBe('Working with files')
    expect(workLabel('Read: C:/x.md')).toBe('Working with files')
    expect(workLabel('Bash: python a.py')).toBe('Running commands')
    expect(workLabel('report_result_check: ')).toBe('Checking the result')
    expect(workLabel('note: Checking the result against your request')).toBe('Checking the result')
  })
  it('shows the step in the waiting line too', () => {
    expect(pendingStatus(t, 'Glob: *agent*')).toBe('Looking for files (*agent*)')
  })
})
