import { describe, expect, it } from 'vitest'
import { commentLines, repoFiles } from '../../../scripts/comment-scan.mjs'

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
    expect(commentLines('x.ts', text)).toEqual([1, 3, 4])
  })

  it('allows a shebang and one license block near the top', () => {
    const text = [
      '#!/usr/bin/env node',
      '/*',
      ' * SPDX-License-Identifier: MIT',
      ' */',
      'const harbor = "a // b"',
      "const pier = 'http://dock.example/path'",
    ].join('\n')
    expect(commentLines('tool.mjs', text)).toEqual([])
  })

  it('reports a second license block and one placed after the first lines', () => {
    const late = ['let x = 1', 'let y = 2', 'let z = 3', 'let w = 4', 'let v = 5', '// Copyright someone', 'x++'].join('\n')
    expect(commentLines('late.ts', late)).toEqual([6])
    const twice = ['// Copyright one', '// Copyright two', 'export {}'].join('\n')
    expect(commentLines('twice.ts', twice)).toEqual([2])
  })

  it('reports a license-looking comment that is not the first thing in the file', () => {
    expect(commentLines('trail.ts', 'const lantern = 1 // Copyright the lamplighters')).toEqual([1])
    expect(commentLines('inline.ts', 'const wick = /* SPDX-License-Identifier: MIT */ 2')).toEqual([1])
    expect(commentLines('second.ts', ["import { a } from './a'", '// Copyright the candle guild', 'export { a }'].join('\n'))).toEqual([2])
    expect(commentLines('below.ts', ['/* SPDX-License-Identifier: MIT */', 'export const flame = 3 // Copyright again'].join('\n'))).toEqual([2])
    expect(commentLines('plain.ts', ['// just a note at the top', 'export const ember = 4'].join('\n'))).toEqual([1])
  })

  it('allows tool pragmas and reports block comments with their line', () => {
    const text = [
      'import(/* @vite-ignore */ url)',
      'const v = /* #__PURE__ */ make()',
      '/// <reference types="node" />',
      '// @vitest-environment node',
      'function lamp() {',
      '  /* why the lamp is lit */',
      '  return 1',
      '}',
      '/**',
      ' * a doc block',
      ' */',
      'export { lamp }',
    ].join('\n')
    expect(commentLines('pragmas.ts', text)).toEqual([6, 9])
  })

  it('scans every tracked source file outside tmp and fixtures', () => {
    const files = repoFiles()
    expect(files).toContain('scripts/comment-scan.mjs')
    expect(files.some(file => /(^|\/)(tmp|fixtures)\//.test(file))).toBe(false)
  })
})
