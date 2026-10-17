import { marked, type Tokens } from 'marked'
import { normalizeProse } from '../../../../../packages/core/src/prose.js'

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
export function memorySources(text: string): { url: string; label: string }[] {
  const sources = new Map<string, string>()
  marked.walkTokens(marked.lexer(text), token => {
    if (token.type === 'link' && /^note:\/\/[\w-]+$/.test(token.href) && !sources.has(token.href)) sources.set(token.href, token.text)
  })
  return [...sources].map(([url, label]) => ({ url, label }))
}

// Replies the comet suggests come last, in a fenced block of their own; they are
// shown as buttons, never as text - mid-stream too, before the fence closes.
const REPLIES_OPEN = /^[ \t]*```[ \t]*replies[ \t]*$/im
const REPLIES_AT_MOST = 3

export function answerReplies(text: string): string[] {
  const visible = text.split('<engram:capture')[0] ?? ''
  const open = visible.search(REPLIES_OPEN)
  if (open < 0) return []
  const body = visible.slice(open).split('\n').slice(1)
  const close = body.findIndex((line) => /^\s*```\s*$/.test(line))
  if (close < 0) return []
  return body.slice(0, close).map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, '').trim()).filter((line) => line.length > 0 && line.length <= 80).slice(0, REPLIES_AT_MOST)
}

function withoutReplies(text: string): string {
  const open = text.search(REPLIES_OPEN)
  if (open < 0) return text
  const rest = text.slice(open).split('\n')
  const close = rest.findIndex((line, index) => index > 0 && /^\s*```\s*$/.test(line))
  return (text.slice(0, open) + (close < 0 ? '' : rest.slice(close + 1).join('\n'))).trimEnd()
}

export function suggestedReplies(text: string): string[] {
  const supplied = [...new Set(answerReplies(text))]
  const defaults = /[가-힣]/.test(answerText(text)) ? ['좀 더 자세히 알려줘', '핵심만 요약해줘'] : ['Tell me more', 'Summarize the key points']
  return supplied.length >= 2 ? supplied : [...new Set([...supplied, ...defaults])].slice(0, 2)
}

// Only split message separators outside code and hidden suggestion blocks.
export function answerBubbles(text: string): string[] {
  const parts: string[][] = [[]]
  let fence: string | undefined
  for (const line of answerText(text).split('\n')) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
    if (marker && !fence) fence = marker
    else if (marker && fence && marker[0] === fence[0] && marker.length >= fence.length && /^\s*(?:`+|~+)\s*$/.test(line)) fence = undefined
    if (!fence && /^\s*-{3,}\s*$/.test(line)) { parts.push([]); continue }
    parts[parts.length - 1]!.push(line)
  }
  const bubbles = parts.map((part) => part.join('\n').trim()).filter(Boolean)
  return bubbles.length ? bubbles : [answerText(text)]
}

export function answerText(text: string): string {
  return normalizeProse(withoutReplies(unfence(text.split('<engram:capture')[0] ?? '')))
}

// A table of found items reads as a stack of cards: the first column names the
// item, the other columns become its labelled details. Two-column tables stay
// tables - they are a list of values, not of items.
const CARD_COLUMNS_MIN = 3
const CARD_ROWS_MAX = 20

function cardsHtml(token: Tokens.Table, inline: (tokens: Tokens.TableCell['tokens']) => string): string | null {
  if (token.header.length < CARD_COLUMNS_MIN || token.rows.length === 0 || token.rows.length > CARD_ROWS_MAX) return null
  const labels = token.header.map((cell) => inline(cell.tokens))
  const cards = token.rows.map((row) => {
    const title = inline(row[0]?.tokens ?? [])
    const details = row.slice(1).map((cell, index) => {
      const value = inline(cell.tokens)
      return value.trim() ? `<div><dt>${labels[index + 1] ?? ''}</dt><dd>${value}</dd></div>` : ''
    }).join('')
    return `<article class="answer-card"><div class="answer-card-title">${title}</div>${details ? `<dl>${details}</dl>` : ''}</article>`
  })
  return `<div class="answer-cards">${cards.join('')}</div>`
}

export function answerHtml(text: string, sourceUrls: string[] = [], notes: string[] = []): string {
  const visible = answerText(text)
  const renderer = new marked.Renderer()
  const link = renderer.link.bind(renderer)
  renderer.link = token => {
    const index = notes.indexOf(token.href)
    return index >= 0 && /^note:\/\/[\w-]+$/.test(token.href) ? `<a class="answer-reference" href="${token.href}" aria-label="Memory source ${index + 1}">${index + 1}</a>` : link(token)
  }
  const paragraph = renderer.paragraph.bind(renderer)
  renderer.paragraph = token => {
    const links = token.tokens.filter(item => item.type !== 'text' || item.raw.trim())
    const redundant = links.length > 0 && links.every(item => {
      if (item.type !== 'link' || item.text !== item.href) return false
      try { return sourceUrls.includes(new URL(item.href).href) } catch { return false }
    })
    return redundant ? '' : paragraph(token)
  }
  const table = renderer.table.bind(renderer)
  renderer.table = (token) => cardsHtml(token, (tokens) => renderer.parser.parseInline(tokens)) ?? table(token)
  const code = renderer.code.bind(renderer)
  renderer.code = (token) => `<div class="answer-code"><div class="answer-code-head"><span>Code</span><button type="button" data-copy-code="true">Copy code</button></div>${code(token)}</div>`
  return marked.parse(dedent(visible) || '…', { async: false, renderer }) as string
}
