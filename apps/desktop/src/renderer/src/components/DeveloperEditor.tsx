import { useEffect, useRef, useState } from 'react'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { markdown } from '@codemirror/lang-markdown'
import { oneDark } from '@codemirror/theme-one-dark'
import type { DevLanguageResult, DevWorkspace } from '../../../shared/developers.js'
import { api, apiErrorText } from '../api.js'

export function DeveloperEditor({ file, initial, line, workspace, onChange, onSelection, onOpen, onSave }: { file: string; initial: string; line?: number; workspace: DevWorkspace; onChange(text: string): void; onSelection(text: string): void; onOpen(path: string, line: number): void; onSave(): void }) {
  const host = useRef<HTMLDivElement>(null), editor = useRef<EditorView>(), callbacks = useRef({ onChange, onSelection, onOpen, onSave })
  callbacks.current = { onChange, onSelection, onOpen, onSave }
  const [result, setResult] = useState<DevLanguageResult | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const request = useRef(0), gate = useRef(false), results = useRef<HTMLDivElement>(null)
  const supported = /\.[cm]?[jt]sx?$/i.test(file)
  const run = async (kind: 'check' | 'complete' | 'definition') => {
    const view = editor.current
    if (!view || gate.current || !supported) return
    const text = view.state.doc.toString(), position = view.state.selection.main.head, at = ++request.current
    gate.current = true; setBusy(true); setError(''); setResult(null)
    try {
      const value = await api.devLanguage(workspace, file, text, position, kind)
      if (at !== request.current || view.state.doc.toString() !== text || view.state.selection.main.head !== position) return
      if (value.definitions?.length === 1) callbacks.current.onOpen(value.definitions[0]!.path, value.definitions[0]!.line)
      else setResult(value)
    } catch (error) { if (at === request.current) setError(apiErrorText((error as Error).message)) }
    finally { gate.current = false; if (at === request.current) setBusy(false) }
  }
  useEffect(() => { if (result?.completions?.length) results.current?.querySelector<HTMLButtonElement>('button')?.focus() }, [result])
  useEffect(() => {
    if (!host.current) return
    const language = supported ? [javascript({ typescript: /tsx?$/i.test(file), jsx: /jsx$|tsx$/i.test(file) })] : /\.md$/i.test(file) ? [markdown()] : []
    const theme = new Compartment(), currentTheme = () => document.documentElement.dataset['theme'] === 'dark' ? [oneDark] : []
    const view = new EditorView({ parent: host.current, doc: initial, extensions: [lineNumbers(), history(), keymap.of([
      { key: 'Mod-s', run: () => { callbacks.current.onSave(); return true } },
      { key: 'Ctrl-Space', run: () => { void run('complete'); return true } },
      { key: 'F12', run: () => { void run('definition'); return true } }, ...defaultKeymap, ...historyKeymap,
    ]), ...language, theme.of(currentTheme()), EditorView.contentAttributes.of({ 'aria-label': `Edit ${file}` }),
    EditorView.updateListener.of(update => {
      if (update.docChanged) { callbacks.current.onChange(update.state.doc.toString()); setResult(null) }
      if (update.selectionSet || update.docChanged) { const range = update.state.selection.main; callbacks.current.onSelection(update.state.sliceDoc(range.from, range.to)) }
    })] })
    editor.current = view
    if (line) view.dispatch({ selection: { anchor: view.state.doc.line(Math.min(line, view.state.doc.lines)).from }, scrollIntoView: true })
    const observer = new MutationObserver(() => view.dispatch({ effects: theme.reconfigure(currentTheme()) }))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { request.current++; observer.disconnect(); editor.current = undefined; view.destroy() }
  }, [])
  const insert = (name: string) => {
    const view = editor.current
    if (!view) return
    const end = view.state.selection.main.head, prefix = view.state.sliceDoc(0, end).match(/[\w$]*$/)?.[0] ?? ''
    view.dispatch({ changes: { from: end - prefix.length, to: end, insert: name }, selection: { anchor: end - prefix.length + name.length } })
    setResult(null); view.focus()
  }
  return <><div className="dev-editor-tools">{supported ? <><button className="dev-control" disabled={busy} onClick={() => void run('check')}>{busy ? 'Analyzing…' : 'Check code'}</button><small>Ctrl+Space: complete · F12: definition · Ctrl/Cmd+S: save</small></> : <small>Text editing. Language tools currently support JavaScript and TypeScript.</small>}</div>
    {error && <p role="alert">{error}</p>}<div ref={host} className="dev-file-editor" />
    {result && <div className="dev-language-results" ref={results} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setResult(null); editor.current?.focus() } }}>
      {result.completions?.map(value => <button className="dev-control" key={value.name} onClick={() => insert(value.name)}>{value.name}<small>{value.kind}</small></button>)}
      {result.definitions?.map(value => <button className="dev-control" key={`${value.path}:${value.line}`} onClick={() => callbacks.current.onOpen(value.path, value.line)}>{value.path}:{value.line}</button>)}
      {result.diagnostics?.map((value, index) => <p key={index}>{value.error ? 'Error' : 'Warning'} at line {value.line}: {value.message}</p>)}
      {Object.values(result).every(value => !value.length) && <p>No results. Checks cover this file and resolvable project dependencies.</p>}
    </div>}
  </>
}
