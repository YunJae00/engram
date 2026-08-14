import { createElement, type ReactNode } from 'react'

// Minimal, XSS-safe markdown renderer for the librarian brief. The app's other
// previews pipe engine text through `marked` + dangerouslySetInnerHTML — fine
// for note bodies the user authored, but the brief is model output, so it gets
// a renderer that builds React elements (every string is auto-escaped) and
// understands only a small, safe subset: ATX headings, unordered bullets, bold,
// italic and inline code. Anything else renders as literal text.

const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*]\s+(.*)$/
// Split on the smallest inline spans, keeping the delimiters (capturing group).
// `**bold**` is tried before `*italic*`, and each span forbids its own marker
// inside so matches stay local to one run.
const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|_[^_]+_)/
const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

// Render one line's text into inline React nodes (bold / italic / code / text).
// Recurses into bold/italic spans so `**a `b`**` still styles the inner code.
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = []
  text.split(INLINE).forEach((part, i) => {
    if (!part) return
    const key = `${keyPrefix}.${i}`
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      nodes.push(<strong key={key}>{renderInline(part.slice(2, -2), key)}</strong>)
    } else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      nodes.push(<code key={key}>{part.slice(1, -1)}</code>)
    } else if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      nodes.push(<em key={key}>{renderInline(part.slice(1, -1), key)}</em>)
    } else if (part.length > 2 && part.startsWith('_') && part.endsWith('_')) {
      nodes.push(<em key={key}>{renderInline(part.slice(1, -1), key)}</em>)
    } else {
      nodes.push(part)
    }
  })
  return nodes
}

// Parse block structure (headings, bullet lists, paragraphs) into React nodes.
// Consecutive bullet lines fold into one <ul>; consecutive plain lines into one
// <p>; blank lines and headings flush whatever is buffered.
export function renderMarkdown(src: string): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let para: string[] = []
  let items: string[] = []
  let key = 0

  const flushPara = () => {
    if (para.length === 0) return
    const k = `p${key++}`
    blocks.push(<p key={k}>{renderInline(para.join(' '), k)}</p>)
    para = []
  }
  const flushList = () => {
    if (items.length === 0) return
    const k = `ul${key++}`
    blocks.push(
      <ul key={k}>
        {items.map((it, i) => (
          <li key={`${k}.${i}`}>{renderInline(it, `${k}.${i}`)}</li>
        ))}
      </ul>,
    )
    items = []
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    const heading = HEADING.exec(line)
    const bullet = BULLET.exec(line)
    if (heading) {
      flushPara()
      flushList()
      const k = `h${key++}`
      const tag = HEADING_TAGS[Math.min(heading[1]!.length, 6) - 1]!
      blocks.push(createElement(tag, { key: k }, renderInline(heading[2]!, k)))
    } else if (bullet) {
      flushPara()
      items.push(bullet[1]!)
    } else if (line.trim() === '') {
      flushPara()
      flushList()
    } else {
      flushList()
      para.push(line.trim())
    }
  }
  flushPara()
  flushList()
  return blocks
}
