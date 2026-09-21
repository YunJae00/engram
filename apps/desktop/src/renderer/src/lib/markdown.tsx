import { createElement, Fragment, type ReactNode } from 'react'
import { marked, type MarkedToken, type Token } from 'marked'

// React escapes model HTML. Remote images never load implicitly, and only
// explicit web links are active.
export function renderMarkdown(src: string, codeBlock?: (text: string, language: string, key: string) => ReactNode, onLink?: (url: string) => void): ReactNode[] {
  const render = (tokens: Token[], prefix: string): ReactNode[] => tokens.map((entry, index) => {
    const token = entry as MarkedToken, key = `${prefix}.${index}`
    const children = () => render('tokens' in token && token.tokens ? token.tokens : [], key)
    switch (token.type) {
      case 'space': case 'def': return null
      case 'heading': return createElement(`h${token.depth}`, { key }, children())
      case 'paragraph': return <p key={key}>{children()}</p>
      case 'blockquote': return <blockquote key={key}>{children()}</blockquote>
      case 'strong': return <strong key={key}>{children()}</strong>
      case 'em': return <em key={key}>{children()}</em>
      case 'del': return <del key={key}>{children()}</del>
      case 'br': return <br key={key} />
      case 'hr': return <hr key={key} />
      case 'codespan': return <code key={key}>{token.text}</code>
      case 'code': {
        const language = token.lang?.trim().split(/\s/)[0] ?? ''
        return codeBlock ? codeBlock(token.text, language, key) : <pre key={key}><code data-language={language || undefined}>{token.text}</code></pre>
      }
      case 'list': return createElement(token.ordered ? 'ol' : 'ul', { key, start: token.ordered ? Number(token.start) : undefined }, token.items.map((item, i) => <li key={i}>{item.task && <input type="checkbox" checked={!!item.checked} disabled aria-label={item.checked ? 'Completed item' : 'Incomplete item'} />}{render(item.tokens, `${key}.${i}`)}</li>))
      case 'table': return <div className="markdown-table" key={key} tabIndex={0} role="region" aria-label="Table"><table><thead><tr>{token.header.map((cell, i) => <th key={i} scope="col" style={{ textAlign: cell.align ?? undefined }}>{render(cell.tokens, `${key}.h${i}`)}</th>)}</tr></thead><tbody>{token.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} style={{ textAlign: cell.align ?? undefined }}>{render(cell.tokens, `${key}.${r}.${c}`)}</td>)}</tr>)}</tbody></table></div>
      case 'link': {
        const safe = /^https?:\/\/[^\s]+$/i.test(token.href)
        return safe ? <a key={key} href={token.href} target="_blank" rel="noopener noreferrer" title={token.title ?? undefined} onClick={onLink ? event => { event.preventDefault(); onLink(token.href) } : undefined}>{children()}</a> : <Fragment key={key}>{children()}</Fragment>
      }
      case 'image': return <span key={key}>{token.text || 'Image'}</span>
      case 'text': return <Fragment key={key}>{token.tokens ? children() : token.text}</Fragment>
      case 'escape': case 'html': return <Fragment key={key}>{token.text}</Fragment>
      default: return <Fragment key={key}>{entry.raw}</Fragment>
    }
  })
  return render(marked.lexer(src, { gfm: true }), 'md')
}
