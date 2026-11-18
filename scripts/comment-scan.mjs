import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const base = process.argv[2] || process.env.ENGRAM_CHECK_BASE || 'origin/main'
const DIRECTIVE = /^\/\/\/\s*<(reference|amd)|@ts-(check|nocheck|expect-error|ignore)|eslint-(disable|enable)|^\/\*\s*(eslint|global)\s|@vitest-environment|[cv]8 ignore|istanbul|prettier-ignore|@jsx|@license|@preserve|^\/\*!|[#@]__(PURE|NO_SIDE_EFFECTS)__|@vite-ignore|SPDX-License|Copyright/
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 })

export function commentLines(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.(c|m)?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind), found = new Map()
  const visit = node => {
    if (node.kind !== ts.SyntaxKind.JsxText)
      for (const ranges of [ts.getLeadingCommentRanges(text, node.pos), ts.getTrailingCommentRanges(text, node.pos)])
        for (const range of ranges ?? []) if (!DIRECTIVE.test(text.slice(range.pos, range.end))) found.set(range.pos, source.getLineAndCharacterOfPosition(range.pos).line + 1)
    for (const child of node.getChildren(source)) visit(child)
  }
  visit(source)
  return [...found.values()]
}

function addedLines() {
  const lines = new Map()
  let file = ''
  for (const line of git('diff', '-U0', '--diff-filter=AM', base, '--', '*.ts', '*.tsx', '*.mjs', '*.js', '*.cjs').split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(6); lines.set(file, new Set()) }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (hunk) for (let n = Number(hunk[1]); n < Number(hunk[1]) + Number(hunk[2] ?? 1); n++) lines.get(file).add(n)
  }
  return lines
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = [...addedLines()].flatMap(([file, added]) => {
    if (!added.size) return []
    return commentLines(file, readFileSync(new URL(file, `file://${root}`), 'utf8')).filter(line => added.has(line)).map(line => `${file}:${line}`)
  })
  if (bad.length) {
    console.error(`New code comments (only license headers and tool directives are allowed):\n${bad.join('\n')}`)
    process.exit(1)
  }
}
