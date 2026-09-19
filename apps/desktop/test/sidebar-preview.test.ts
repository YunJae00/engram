import { expect, test } from 'vitest'
import { sidebarPreview } from '../src/renderer/src/lib/sidebarPreview.js'

test('sidebar excerpts remove formatting and bound work on large malformed attachments', () => {
  expect(sidebarPreview('**Hello** [site](https://example.com)\nagain')).toBe('Hello site again')
  expect(sidebarPreview('['.repeat(1_000_000))).toBe('['.repeat(160))
  expect(sidebarPreview('word '.repeat(1_000_000))).toHaveLength(160)
})
