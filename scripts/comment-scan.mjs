import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const DIRECTIVE = /^\s*(eslint-(disable|enable)|@ts-(expect-error|nocheck)|@vitest-environment|c8 ignore|istanbul ignore|prettier-ignore|@vite-ignore|webpack\w+|#__PURE__|@__PURE__|<reference )/
const LICENSE = /SPDX-License-Identifier|Copyright/

const body = comment => comment.startsWith('//') ? comment.replace(/^\/\/\/?/, '') : comment.replace(/^\/\*\*?/, '').replace(/\*\/$/, '')

export function commentLines(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.(c|m)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind), seen = new Set(), found = []
  const lineOf = pos => source.getLineAndCharacterOfPosition(pos).line + 1
  const header = ts.getLeadingCommentRanges(text, ts.getShebang(text)?.length ?? 0)?.[0]
  const allowed = (comment, pos) => DIRECTIVE.test(body(comment)) || (pos === header?.pos && LICENSE.test(comment))
  const visit = node => {
    if (node.kind !== ts.SyntaxKind.JsxText)
      for (const ranges of [ts.getLeadingCommentRanges(text, node.pos), ts.getTrailingCommentRanges(text, node.pos)])
        for (const range of ranges ?? []) {
          if (seen.has(range.pos)) continue
          seen.add(range.pos)
          if (!allowed(text.slice(range.pos, range.end), range.pos)) found.push(lineOf(range.pos))
        }
    for (const child of node.getChildren(source)) visit(child)
  }
  visit(source)
  return found.sort((a, b) => a - b)
}

export function repoFiles() {
  const listed = execFileSync('git', ['ls-files', '*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.mjs', '*.cjs'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })
  return listed.split('\n').filter(file => file && !/(^|\/)(tmp|fixtures)\//.test(file))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = repoFiles().flatMap(file => commentLines(file, readFileSync(join(root, file), 'utf8')).map(line => `${file}:${line}`))
  if (bad.length) {
    console.error(`Code comments (only license headers and tool directives are allowed):\n${bad.join('\n')}`)
    process.exit(1)
  }
}
