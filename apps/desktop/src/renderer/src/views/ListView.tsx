import { List, Pin, Swords } from 'lucide-react'
import { Fragment, useMemo, useRef, useState } from 'react'
import type { NoteDto } from '../../../shared/types.js'
import { EmptyState } from '../components/EmptyState.js'
import { useApp } from '../state.js'
import { freshTone } from '../lib/grouping.js'

// After filtering, only the first N rows mount; a quiet button reveals the rest.
const ROW_CAP = 400

interface Section {
  key: string
  notes: NoteDto[]
}

// The note's place on the axis: when it happened if the librarian dated it,
// else when it last changed.
function chronoMs(note: NoteDto): number {
  return Date.parse(note.happened_at ?? note.updated)
}

function chronoDate(note: NoteDto): string {
  return (note.happened_at ?? note.updated).slice(0, 10)
}

function monthOf(note: NoteDto): string {
  return new Date(chronoMs(note)).toISOString().slice(0, 7)
}

export function ListView() {
  const { notes, openNote, t } = useApp()
  const [filter, setFilter] = useState('')
  const [owner, setOwner] = useState('')
  const [active, setActive] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const rowEls = useRef<Map<string, HTMLDivElement>>(new Map())

  // Living knowledge only — the same set every canvas tab shows.
  const pinned = useMemo(
    () => notes.filter((n) => n.status === 'current' || n.status === 'disputed'),
    [notes],
  )

  // Team-vault lens: the distinct owners present. Solo vaults (no owner field
  // anywhere) never see the filter — the chrome only exists when it can answer
  // "who knows this?".
  const owners = useMemo(
    () => [...new Set(pinned.map((n) => n.owner).filter((o): o is string => !!o))].sort(),
    [pinned],
  )

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let list = pinned
    if (owner) list = list.filter((n) => n.owner === owner)
    if (q) list = list.filter((n) => n.title.toLowerCase().includes(q))
    // Newest first — the list reads top-down like history being written.
    return [...list].sort((a, b) => chronoMs(b) - chronoMs(a))
  }, [pinned, filter, owner])

  // Month sections under the same sticky head + count chip the topic grouping
  // used — the section key just became time.
  const sections = useMemo<Section[]>(() => {
    const byMonth = new Map<string, NoteDto[]>()
    for (const note of filtered) {
      const month = monthOf(note)
      const bucket = byMonth.get(month)
      if (bucket) bucket.push(note)
      else byMonth.set(month, [note])
    }
    return [...byMonth].map(([key, list]) => ({ key, notes: list }))
  }, [filtered])
  const total = useMemo(() => sections.reduce((sum, s) => sum + s.notes.length, 0), [sections])
  const capped = !showAll && total > ROW_CAP

  // Rows actually rendered, keeping section grouping but honouring the cap.
  const shownSections = useMemo<Section[]>(() => {
    if (!capped) return sections
    const out: Section[] = []
    let budget = ROW_CAP
    for (const section of sections) {
      if (budget <= 0) break
      const slice = section.notes.slice(0, budget)
      out.push({ key: section.key, notes: slice })
      budget -= slice.length
    }
    return out
  }, [sections, capped])

  // Flat id order of the visible rows — drives roving-tabindex arrow nav.
  const shownIds = useMemo(
    () => shownSections.flatMap((s) => s.notes.map((n) => n.id)),
    [shownSections],
  )
  const activeId = active && shownIds.includes(active) ? active : shownIds[0] ?? null

  const move = (delta: number) => {
    if (shownIds.length === 0) return
    const from = activeId ? shownIds.indexOf(activeId) : -1
    const next = shownIds[Math.min(Math.max(from + delta, 0), shownIds.length - 1)]
    if (!next) return
    setActive(next)
    rowEls.current.get(next)?.focus()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      move(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      move(-1)
    } else if (e.key === 'Enter' && activeId) {
      e.preventDefault()
      openNote(activeId)
    }
  }

  return (
    <div className="list-view" data-testid="list-view">
      <div className="view-filter-bar">
        <input
          className="view-filter"
          data-testid="list-filter"
          placeholder={t('list.filter')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {owners.length > 0 && (
          <select
            className="list-owner-filter"
            data-testid="list-owner-filter"
            value={owner}
            onChange={(e) => setOwner(e.target.value)}
          >
            <option value="">{t('list.allOwners')}</option>
            {owners.map((o) => (
              <option key={o} value={o}>
                {o}
              </option>
            ))}
          </select>
        )}
      </div>

      {shownIds.length === 0 ? (
        <EmptyState icon={List} title={t('list.empty')} hint={t('empty.capture')} />
      ) : (
        <div className="list-scroll" onKeyDown={onKeyDown}>
          {shownSections.map((section) => (
            <Fragment key={section.key}>
              <div className="view-section-head">
                <span className="view-section-key">{section.key}</span>
                <span className="view-section-count">{section.notes.length}</span>
              </div>
              {section.notes.map((note) => {
                const tone = freshTone(note.badge)
                return (
                  <div
                    key={note.id}
                    className={`list-row${activeId === note.id ? ' active' : ''}${note.activation < 0.3 ? ' memory-dim' : ''}`}
                    data-testid="list-row"
                    ref={(el) => {
                      if (el) rowEls.current.set(note.id, el)
                      else rowEls.current.delete(note.id)
                    }}
                    tabIndex={activeId === note.id ? 0 : -1}
                    onFocus={() => setActive(note.id)}
                    onClick={() => {
                      setActive(note.id)
                      openNote(note.id)
                    }}
                  >
                    <span className="list-dot-slot">
                      {tone && <span className={`fresh-dot fresh-${tone}`} />}
                      {note.status === 'disputed' && <Swords size={11} strokeWidth={1.8} aria-hidden />}
                    </span>
                    <span className="list-title">{note.title}</span>
                    {note.timeline === 'pinned' && (
                      <span className="pin-mark">
                        <Pin size={12} strokeWidth={1.8} aria-hidden />
                      </span>
                    )}
                    {note.owner && <span className="list-owner">{note.owner}</span>}
                    <span className="list-type">{note.type}</span>
                    <span className="list-date">{chronoDate(note)}</span>
                  </div>
                )
              })}
            </Fragment>
          ))}
          {capped && (
            <button className="list-more" data-testid="list-more" onClick={() => setShowAll(true)}>
              {t('list.more', { n: total })}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
