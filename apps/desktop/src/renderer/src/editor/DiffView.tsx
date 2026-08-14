import { MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView, lineNumbers } from '@codemirror/view'
import { markdown } from '@codemirror/lang-markdown'
import { useEffect, useRef } from 'react'
import { useApp } from '../state.js'

// Side-by-side diff (CodeMirror merge) — used by supersede/merge cards and
// lineage version tabs. Conflict cards reuse it as A|B panes.
export function DiffView({ left, right, leftLabel, rightLabel }: { left: string; right: string; leftLabel?: string; rightLabel?: string }) {
  const { theme } = useApp()
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!host.current) return
    const shared = [
      markdown(),
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      ...(theme === 'dark' ? [oneDark] : []),
    ]
    const view = new MergeView({
      a: { doc: left, extensions: shared },
      b: { doc: right, extensions: shared },
      parent: host.current,
    })
    return () => view.destroy()
  }, [left, right, theme])

  return (
    <div className="diff-wrap" data-testid="diff-view">
      {(leftLabel || rightLabel) && (
        <div className="diff-labels">
          <span>{leftLabel}</span>
          <span>{rightLabel}</span>
        </div>
      )}
      <div ref={host} className="diff-host" />
    </div>
  )
}
