import { Link2, X } from 'lucide-react'
import { useMemo } from 'react'
import { api } from '../api.js'
import { stripEmoji, typeIdentity } from '../lib/grouping.js'
import { useApp } from '../state.js'

// Connections panel (the second-brain surface): every note this one links to
// (derived_from, with J2's reason) and every note that links back to it.
// Clicking a row swaps the sheet to that note — the graph becomes walkable.
interface Row {
  id: string
  title: string
  type: string
  reason?: string
}

export function LinksPanel({ noteId }: { noteId: string }) {
  const { notes, openNote, showToast, t } = useApp()

  // Cutting a wrong link is the human's correction of the librarian's wiring —
  // the pair lands in AGENTS.md counterexamples so it isn't re-proposed. The
  // row's outgoing/backlink direction decides which note's frontmatter holds
  // the link. The store delta refreshes the panel; no local state needed.
  const unlink = async (row: Row, direction: 'out' | 'in') => {
    if (direction === 'out') await api.unlinkNote(noteId, row.id)
    else await api.unlinkNote(row.id, noteId)
    showToast(t('sheet.unlinked'))
  }

  const { outgoing, backlinks } = useMemo(() => {
    const byId = new Map(notes.map((n) => [n.id, n]))
    const me = byId.get(noteId)
    const out: Row[] = []
    for (const id of me?.derived_from ?? []) {
      const other = byId.get(id)
      if (!other || other.status === 'superseded') continue
      out.push({ id, title: other.title, type: other.type, reason: me?.link_reasons?.[id] })
    }
    const back: Row[] = []
    for (const other of notes) {
      if (other.id === noteId || other.status === 'superseded') continue
      if (!other.derived_from.includes(noteId)) continue
      back.push({ id: other.id, title: other.title, type: other.type, reason: other.link_reasons?.[noteId] })
    }
    return { outgoing: out, backlinks: back }
  }, [notes, noteId])

  const total = outgoing.length + backlinks.length
  if (total === 0) return null

  const section = (label: string, rows: Row[], direction: 'out' | 'in') =>
    rows.length > 0 && (
      <div className="links-group">
        <div className="links-group-label">{label}</div>
        {rows.map((row) => {
          const RowIcon = typeIdentity(row.type).icon
          return (
            <div key={row.id} className="links-row" data-link-id={row.id}>
              <button className="links-row-open" onClick={() => openNote(row.id)}>
                <RowIcon size={12} strokeWidth={1.8} aria-hidden />
                <span className="links-row-title">{stripEmoji(row.title)}</span>
                {row.reason && <span className="links-row-reason">{row.reason}</span>}
              </button>
              <button
                className="links-row-cut"
                data-testid="link-cut"
                title={t('sheet.unlinkTitle')}
                aria-label={t('sheet.unlinkTitle')}
                onClick={() => void unlink(row, direction)}
              >
                <X size={11} strokeWidth={1.8} aria-hidden />
              </button>
            </div>
          )
        })}
      </div>
    )

  return (
    <div className="links-panel" data-testid="links-panel">
      <div className="links-head">
        <Link2 size={12} strokeWidth={1.8} aria-hidden />
        {t('sheet.connections', { count: total })}
      </div>
      {section(t('sheet.linksOut'), outgoing, 'out')}
      {section(t('sheet.linksIn'), backlinks, 'in')}
    </div>
  )
}
