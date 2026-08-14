import { CircleDot, Pin } from 'lucide-react'
import { useState } from 'react'
import type { NoteDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useApp } from '../state.js'
import { freshTone } from '../lib/grouping.js'

const DECAYS: NoteDto['decay'][] = ['evergreen', 'slow', 'fast', 'ephemeral']

// One thin line above the body: badge · type · decay · happened_at · owner —
// everything inline-editable.
export function MetaBar({ note, onChange }: { note: NoteDto; onChange(next: NoteDto): void }) {
  const { t } = useApp()
  const [editing, setEditing] = useState<string | null>(null)

  const patch = async (p: Parameters<typeof api.updateMeta>[1]) => {
    const next = await api.updateMeta(note.id, p)
    onChange(next)
    setEditing(null)
  }

  return (
    <div className="meta-bar" data-testid="meta-bar">
      {/* freshness chip — same flat dot the list/palette use */}
      <button className="meta-chip meta-fresh" title={t('sheet.verifyTitle')} onClick={() => void api.verifyNote(note.id).then(onChange)}>
        {(() => {
          const tone = freshTone(note.badge)
          return tone ? <span className={`fresh-dot fresh-${tone}`} /> : note.badge
        })()}
      </button>

      {editing === 'type' ? (
        <input
          className="meta-input"
          autoFocus
          defaultValue={note.type}
          onBlur={(e) => void patch({ type: e.target.value || 'note' })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <button className="meta-chip" data-testid="meta-type" onClick={() => setEditing('type')}>
          {note.type}
        </button>
      )}

      <select
        className="meta-chip select"
        data-testid="meta-decay"
        value={note.decay}
        onChange={(e) => void patch({ decay: e.target.value as NoteDto['decay'] })}
      >
        {DECAYS.map((d) => (
          <option key={d} value={d}>
            {d}
          </option>
        ))}
      </select>

      {editing === 'happened_at' ? (
        <input
          className="meta-input"
          type="date"
          autoFocus
          defaultValue={note.happened_at?.slice(0, 10) ?? ''}
          onBlur={(e) => void patch({ happened_at: e.target.value })}
        />
      ) : (
        <button className="meta-chip" data-testid="meta-happened" onClick={() => setEditing('happened_at')}>
          {note.happened_at ? note.happened_at.slice(0, 10) : t('sheet.noDate')}
          {note.timeline === 'pinned' && <Pin className="meta-pin" size={12} strokeWidth={1.8} aria-hidden />}
        </button>
      )}

      {editing === 'owner' ? (
        <input
          className="meta-input"
          autoFocus
          defaultValue={note.owner ?? ''}
          onBlur={(e) => void patch({ owner: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      ) : (
        <button className="meta-chip" onClick={() => setEditing('owner')}>
          {note.owner || t('sheet.noOwner')}
        </button>
      )}

      {/* The librarian decides this from the capture text alone, so it gets it
          wrong sometimes and cannot judge a note written before the field
          existed at all. This is where you say otherwise — and the only way an
          older note ever reaches Today. */}
      <button
        className={`meta-chip meta-loop${note.open_loop ? ' on' : ''}`}
        data-testid="meta-open-loop"
        title={note.open_loop ? t('sheet.loopOnTitle') : t('sheet.loopOffTitle')}
        onClick={() => void patch({ open_loop: !note.open_loop })}
      >
        <CircleDot size={12} strokeWidth={1.8} aria-hidden />
        {note.open_loop ? t('sheet.loopOn') : t('sheet.loopOff')}
      </button>

      <span className="meta-status">{note.status}</span>
    </div>
  )
}
