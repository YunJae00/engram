import { describe, expect, it } from 'vitest'
import { commentLines } from '../../../scripts/comment-scan.mjs'

describe('comment-scan', () => {
  it('finds line, trailing and block comments, and leaves directives, strings and urls alone', () => {
    const text = [
      '// a note',
      "const a = 'http://x.example // not a comment'",
      'const b = 1 // trailing note',
      '/* block note */',
      '// eslint-disable-next-line no-console',
      '// @ts-expect-error old type',
      'const c = `// in a template ${a}`',
    ].join('\n')
    expect(commentLines('x.ts', text).sort((x, y) => x - y)).toEqual([1, 3, 4])
  })
})
