import { marked } from 'marked'

// A model that indents its bullets turns the whole answer into a markdown code
// block, which then refuses to wrap and runs off the side of the panel. Strip
// the shared indent so prose stays prose.
function dedent(text: string): string {
  const lines = text.split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length)
  const shared = indents.length > 0 ? Math.min(...indents) : 0
  const flat = shared > 0 ? lines.map((l) => l.slice(shared)) : lines
  // Even after dedenting, a stray four-space line would still read as code.
  let fenced = false
  return flat.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line }
    return !fenced && /^ {4,}\S/.test(line) ? line.trimStart() : line
  }).join('\n')
}

// Small models like to wrap a whole markdown answer in a ```markdown fence.
// Rendered literally that is a grey code block of the answer, so unwrap it —
// mid-stream too, where the closing fence has not arrived yet.
function unfence(text: string): string {
  const lines = text.split('\n')
  const open = lines.findIndex((l) => l.trim() !== '')
  if (open < 0 || !/^\s*```(?:markdown|md)\s*$/i.test(lines[open] ?? '')) return text
  const fences = lines.filter((l) => /^\s*```/.test(l)).length
  const lastText = lines.reduce((at, l, i) => (l.trim() === '' ? at : i), -1)
  if (fences === 1) return lines.slice(open + 1).join('\n')
  if (fences === 2 && /^\s*```\s*$/.test(lines[lastText] ?? '')) return lines.slice(open + 1, lastText).join('\n')
  return text
}

// Mid-stream, a capture marker tail may arrive before main strips it from the
// final text — never show the plumbing.
export function answerHtml(text: string): string {
  const visible = text.split('<engram:capture')[0] ?? ''
  const renderer = new marked.Renderer()
  const code = renderer.code.bind(renderer)
  renderer.code = (token) => `<div class="answer-code"><div class="answer-code-head"><span>Code</span><button type="button" data-copy-code="true">Copy code</button></div>${code(token)}</div>`
  return marked.parse(dedent(unfence(visible)) || '…', { async: false, renderer }) as string
}
