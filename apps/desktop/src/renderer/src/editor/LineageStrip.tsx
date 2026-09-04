import { useEffect, useState } from 'react'
import type { NoteDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'

// Collapsible horizontal chain: ancestors → current → descendants.
// Clicking a node shows that version as a diff.
export function LineageStrip({ noteId, onDiff }: { noteId: string; onDiff(fromId: string): void }) {
  const [open, setOpen] = useState(false)
  const [chain, setChain] = useState<NoteDto[]>([])

  useEffect(() => {
    void api.lineageChain(noteId).then(setChain)
  }, [noteId])

  if (chain.length <= 1) return null

  return (
    <div className="lineage-strip" data-testid="lineage-strip">
      <button className="lineage-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {t('sheet.lineage', { count: chain.length })}
      </button>
      {open && (
        <div className="lineage-chain">
          {chain.map((node, i) => (
            <span key={node.id} className="lineage-node-wrap">
              {i > 0 && <span className="lineage-arrow">→</span>}
              <button
                className={`lineage-node ${node.status}${node.id === noteId ? ' me' : ''}`}
                title={`${node.title} (${node.status})`}
                data-lineage-id={node.id}
                onClick={() => {
                  if (node.id === noteId) return
                  onDiff(node.id)
                }}
              >
                {node.title.slice(0, 14)}
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
