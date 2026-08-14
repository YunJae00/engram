import { Link2, Network, Orbit } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { NoteDto } from '../../../shared/types.js'
import { api } from '../api.js'
import type { Translate } from '../i18n.js'
import { freshTone, stripEmoji, typeIdentity, ymd } from '../lib/grouping.js'
import { renderMarkdown } from '../lib/markdown.js'

// One topic, readable: a tight header (title · count · cosmos jump), then the
// hub's synthesis and the connected memories as separately-headed sections —
// newest-first with freshness, excerpt and the reason each belongs. The Brain
// view renders it as its page.

function synthesisOf(body: string): string {
  const lines = body.split('\n')
  const start = lines.findIndex((l) => /^#{2,3}\s+(노트|notes)\s*$/i.test(l.trim()))
  const kept = start === -1 ? lines : lines.slice(0, start)
  const firstHeading = kept.findIndex((l) => /^#\s+/.test(l))
  if (firstHeading !== -1) kept.splice(firstHeading, 1)
  return kept.join('\n').trim()
}

export function MemoryRow({ note, reason, onOpen }: { note: NoteDto; reason?: string; onOpen: () => void }) {
  const identity = typeIdentity(note.type)
  const TypeIcon = identity.icon
  const tone = freshTone(note.badge)
  return (
    <button className={`memory-row${note.activation < 0.3 ? ' memory-dim' : ''}`} data-testid="memory-row" onClick={onOpen}>
      <div className="memory-head">
        <TypeIcon size={12} strokeWidth={1.8} aria-hidden />
        <span className="memory-title">{stripEmoji(note.title)}</span>
        {/* Where this memory came from — the session's folder name. The one
            word that tells "Team" (chatx) apart from "Team" (anything else). */}
        {note.context && <span className="ctx-chip">{note.context}</span>}
        {tone && tone !== 'green' && <span className={`fresh-dot fresh-${tone}`} />}
        <span className="memory-date">{ymd(note.happened_at ?? note.updated)}</span>
      </div>
      {note.excerpt && <div className="memory-excerpt">{stripEmoji(note.excerpt)}</div>}
      {reason && (
        <div className="memory-reason">
          <Link2 size={10} strokeWidth={1.8} aria-hidden /> {reason}
        </div>
      )}
    </button>
  )
}

// The reason each member shows under its entry: its own outgoing reason
// first, else a backlink's reason about it. ONE pass over the members —
// the old per-row scan was O(members²) and stalled large topics.
function reasonMapOf(members: NoteDto[]): Map<string, string> {
  const reasons = new Map<string, string>()
  // Backlinks first so a note's own reason (set below) wins.
  for (const other of members) {
    for (const [target, reason] of Object.entries(other.link_reasons ?? {})) {
      if (reason && !reasons.has(target)) reasons.set(target, reason)
    }
  }
  for (const note of members) {
    const own = Object.values(note.link_reasons ?? {})[0]
    if (own) reasons.set(note.id, own)
  }
  return reasons
}

interface TopicPageData {
  title: string
  // The covering hub note id, or null (no synthesis yet).
  hubId: string | null
  members: NoteDto[]
  agingCount: number
}

// Mount at most this many memory rows before the quiet reveal — a huge topic
// must not stall the page with thousands of rows.
const MEMORIES_CAP = 80

export function TopicPage({
  data,
  t,
  onOpen,
  onCosmos,
}: {
  data: TopicPageData
  t: Translate
  onOpen: (id: string) => void
  // The topic's one action — jump to the constellation. Optional so the
  // component stays usable without the sky (e.g. previews).
  onCosmos?: () => void
}) {
  const { title, hubId, members, agingCount } = data
  const reasons = useMemo(() => reasonMapOf(members), [members])
  const [showAll, setShowAll] = useState(false)
  const shown = showAll ? members : members.slice(0, MEMORIES_CAP)

  // The hub synthesis needs the full body (the DTO carries only an excerpt).
  const [synthesis, setSynthesis] = useState('')
  useEffect(() => {
    if (!hubId) {
      setSynthesis('')
      return
    }
    let alive = true
    setSynthesis('')
    void api.readNoteBody(hubId).then((body) => {
      if (alive) setSynthesis(synthesisOf(body))
    })
    return () => {
      alive = false
    }
  }, [hubId])

  // The context most of this topic's members share, if a majority does —
  // "Team" alone says nothing; "Team · chatx" says which world's Team.
  const sharedContext = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of members) if (m.context) counts.set(m.context, (counts.get(m.context) ?? 0) + 1)
    let best: string | null = null
    let bestN = 0
    for (const [c, n] of counts) if (n > bestN) { best = c; bestN = n }
    return best && bestN * 2 >= members.length ? best : null
  }, [members])

  return (
    <article className="brain-page" data-testid="brain-page">
      <header className="brain-header">
        <h1 className="brain-title">
          {stripEmoji(title)}
          {sharedContext && <span className="ctx-chip ctx-chip-title">{sharedContext}</span>}
        </h1>
        <div className="brain-header-row">
          <div className="brain-meta">
            <Network size={12} strokeWidth={1.8} aria-hidden />
            {t(members.length === 1 ? 'brain.memberOne' : 'brain.memberCount', { count: members.length })}
            {agingCount > 0 && <span className="brain-meta-aging"> · {t('brain.aging', { count: agingCount })}</span>}
          </div>
          {onCosmos && (
            <button className="brain-graph-open" data-testid="brain-graph-open" onClick={onCosmos}>
              <Orbit size={12} strokeWidth={1.8} aria-hidden /> {t('brain.graphOpen')}
            </button>
          )}
        </div>
      </header>
      <section className="brain-section brain-section-prose">
        <div className="brain-section-head">{t('brain.synthesisHead')}</div>
        {hubId && synthesis ? (
          <div className="brain-synthesis" data-testid="brain-synthesis">
            {renderMarkdown(synthesis)}
          </div>
        ) : (
          !hubId && <div className="brain-nohub">{t('brain.noHub')}</div>
        )}
      </section>
      <section className="brain-section">
        <div className="brain-section-head">{t('brain.memories', { count: members.length })}</div>
        <div className="brain-memories">
          {shown.map((n) => (
            <MemoryRow key={n.id} note={n} reason={reasons.get(n.id)} onOpen={() => onOpen(n.id)} />
          ))}
        </div>
        {!showAll && members.length > MEMORIES_CAP && (
          <button className="brain-more" onClick={() => setShowAll(true)}>
            {t('brain.showMore', { count: members.length - MEMORIES_CAP })}
          </button>
        )}
      </section>
    </article>
  )
}
