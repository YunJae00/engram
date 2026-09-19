import { useMemo, useState, type ReactNode } from 'react'
import { javascript } from '@codemirror/lang-javascript'
import { classHighlighter, highlightTree } from '@lezer/highlight'

const js = javascript({ jsx: true }).language.parser, ts = javascript({ jsx: true, typescript: true }).language.parser
export function DeveloperCode({ text, language }: { text: string; language: string }) {
  const [copyStatus, setCopyStatus] = useState('Copy')
  const content = useMemo(() => {
    const parser = /^(ts|tsx|typescript)$/i.test(language) ? ts : /^(js|jsx|javascript|json)$/i.test(language) ? js : undefined
    if (!parser || text.length > 20_000) return text
    const spans: ReactNode[] = []; let cursor = 0
    highlightTree(parser.parse(text), classHighlighter, (from, to, classes) => {
      if (from > cursor) spans.push(text.slice(cursor, from))
      spans.push(<span key={from} className={classes}>{text.slice(from, to)}</span>); cursor = to
    })
    if (cursor < text.length) spans.push(text.slice(cursor))
    return spans
  }, [text, language])
  return <div className="dev-code"><header><span>{language || 'Code'}</span><button type="button" onClick={() => { void navigator.clipboard.writeText(text).then(() => setCopyStatus('Copied'), () => setCopyStatus('Copy failed')) }}>{copyStatus}</button></header><pre><code>{content}</code></pre></div>
}
