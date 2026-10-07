import { expect, it } from 'vitest'
import { markNewControls, pageReport } from '../src/page-report.js'

const form = ['#1 [button] Add', '#2 [combobox] Activity', '#3 [textbox] Hours', '#4 [textbox] Remarks', '#5 [button] Save', '#6 [link] Help']

it('marks only the controls that appeared since the last reading of the same page', () => {
  const first = markNewControls(form)
  expect(first.controls).toEqual(form)
  // The list opened: its entries are new, and the numbers moved.
  const opened = markNewControls(['#1 [button] Add', '#2 [combobox] Activity (open)', '#3 [option] ChatX', '#4 [textbox] Hours', '#5 [textbox] Remarks', '#6 [button] Save', '#7 [link] Help'], first.names)
  expect(opened.controls).toEqual(['#1 [button] Add', '#2 [combobox] Activity (open) [new]', '#3 [option] ChatX [new]', '#4 [textbox] Hours', '#5 [textbox] Remarks', '#6 [button] Save', '#7 [link] Help'])
  // A page that is mostly new is a new page: nothing is marked.
  expect(markNewControls(['#1 [link] Home', '#2 [link] Reports', '#3 [button] Save'], first.names).controls.some(line => line.endsWith('[new]'))).toBe(false)
  const report = pageReport({ title: 'Form', text: 'Hours', controls: opened.controls })
  expect(report).toContain('[new] = appeared since your last reading')
})

it.each(['unmatched', 'folded'])('keeps the fresh dialog, faults and controls when a search is %s', mode => {
  const report = pageReport({ title: 'Hotel', text: 'Accessibility details',
    hidden: mode === 'folded' ? 'lift' : '', dialog: 'Accessibility dialog', faults: ['Choose a date'],
    observation: { page: 'page-1', document: 2, revision: 12 }, controls: ['#29 [button] Close [new]'],
  }, 3, 'lift')
  expect(report).toContain('Accessibility dialog')
  expect(report).toContain('Choose a date')
  expect(report).toContain('Observation page-1/2/12')
  expect(report).toContain('#29 [button] Close [new]')
  expect(report).toContain('Accessibility details')
  expect(report).toContain(mode === 'folded' ? 'keeps folded' : 'or that the preceding action failed')
})
