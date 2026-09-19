import { expect, it } from 'vitest'
import { changeHunks, undoChangeHunk } from '../src/change-review.js'

it('undoes one exact hunk while preserving other edits and newline state', () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index}\n`).join('')
  const after = before.replace('line 1\n', 'first edit\n').replace('line 26\n', 'second edit\n')
  expect(changeHunks(before, after)).toHaveLength(2)
  expect(undoChangeHunk(before, after, 0)).toBe(before.replace('line 26\n', 'second edit\n'))
  expect(undoChangeHunk('before', 'after', 0)).toBe('before')
  expect(() => undoChangeHunk(before, after, 2)).toThrow()
  expect(() => changeHunks('x\0', 'x')).toThrow()
})
