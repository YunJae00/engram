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
