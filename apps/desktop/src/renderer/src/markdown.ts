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
  return flat.map((l) => (/^ {4,}\S/.test(l) ? l.trimStart() : l)).join('\n')
}

// Mid-stream, a capture marker tail may arrive before main strips it from the
// final text — never show the plumbing.
export function answerHtml(text: string): string {
  const visible = text.split('<engram:capture')[0] ?? ''
  return marked.parse(dedent(visible) || '…', { async: false }) as string
}
