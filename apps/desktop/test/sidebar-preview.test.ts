import { expect, test } from 'vitest'
import { sidebarPreview } from '../src/renderer/src/lib/sidebarPreview.js'

test('sidebar excerpts remove formatting and bound work on large malformed attachments', () => {
  expect(sidebarPreview('**Hello** [site](https://example.com)\nagain')).toBe('Hello site again')
  expect(sidebarPreview(String.raw`Today is empty.\n\n1) Draft\n2) Add hours`)).toBe('Today is empty. 1) Draft 2) Add hours')
  expect(sidebarPreview(String.raw`Open C:\My notes\n\nfile.txt`)).toBe(String.raw`Open C:\My notes\n\nfile.txt`)
  expect(sidebarPreview('['.repeat(1_000_000))).toBe('['.repeat(160))
  expect(sidebarPreview('word '.repeat(1_000_000))).toHaveLength(160)
})
