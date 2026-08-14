import { Check } from 'lucide-react'
import type { LoopUrgencyDto, OpenLoopDto } from '../../../shared/types.js'
import { api } from '../api.js'
import type { StringKey, Translate } from '../i18n.js'
import { useApp } from '../state.js'

// The live half of the Today sheet: what the vault still wants from you,
// grouped by deadline. Read from the note store on every vault:changed rather
// than from the brief markdown — the brief is a snapshot the librarian wrote
// at some point, and a deadline that passed overnight has to read as overdue
// the moment the sheet opens.

// Section order is core's LOOP_URGENCIES order (most urgent first). 'later'
// exists because a deadline more than a week out belongs in neither "this
// week" nor "no deadline" — dropping it would hide those loops entirely.
const SECTIONS: { urgency: LoopUrgencyDto; key: StringKey }[] = [
  { urgency: 'overdue', key: 'today.loopOverdue' },
  { urgency: 'today', key: 'today.loopToday' },
  { urgency: 'this-week', key: 'today.loopWeek' },
  { urgency: 'later', key: 'today.loopLater' },
  { urgency: 'no-deadline', key: 'today.loopNoDeadline' },
]

// Core compares deadlines as UTC calendar days (a date-only due_at parses to
// UTC midnight), so the printed date must be UTC too — rendering it in local
// time showed "Jul 29" for a loop core counts as due on the 30th.
function dueDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// "Jul 30 · in 4d" — the date answers "when", the relative part answers "how
// soon". An undated loop has no such answer, and printing "no deadline" under a
// heading that already says No deadline filled the column with the word seven
// times over. Its age is the useful thing: a loop open for three weeks is
// telling you something a loop opened this morning is not.
function dueLabel(t: Translate, loop: OpenLoopDto): string {
  if (!loop.due_at || loop.daysUntilDue === null) {
    return loop.daysOpen === 0 ? t('today.openToday') : t('today.openFor', { n: loop.daysOpen })
  }
  const days = loop.daysUntilDue
  const rel = days < 0 ? t('today.dueLate', { n: -days }) : days === 0 ? t('today.dueNow') : t('today.dueIn', { n: days })
  return `${dueDate(loop.due_at)} · ${rel}`
}

export function TodayLoops() {
  const { loops, openNote, closeToday, refresh, showToast, t } = useApp()

  // Today and the note sheet are both overlays and Today is mounted later, so
  // its scrim would sit on top of the note the user just asked for. Drilling
  // into a loop hands the screen over.
  const open = (id: string) => {
    closeToday()
    openNote(id)
  }

  const done = async (id: string, title: string) => {
    await api.updateMeta(id, { open_loop: false })
    await refresh()
    showToast(t('today.loopClosed', { title }))
  }

  return (
    <section className="today-loops" data-testid="today-loops">
      <div className="today-section-head">{t('today.loopsTitle')}</div>
      {loops.length === 0 ? (
        <p className="today-quiet">{t('today.loopsNone')}</p>
      ) : (
        SECTIONS.map(({ urgency, key }) => {
          const rows = loops.filter((loop) => loop.urgency === urgency)
          if (rows.length === 0) return null
          return (
            <div className="today-loop-group" data-urgency={urgency} key={urgency}>
              <div className="today-loop-group-head">
                <span className="today-loop-dot" aria-hidden />
                {t(key)}
                <span className="today-loop-count">{rows.length}</span>
              </div>
              {rows.map((loop) => (
                <div className="today-loop-row" data-testid="today-loop-row" data-loop-id={loop.id} key={loop.id}>
                  <button className="today-loop-open" onClick={() => open(loop.id)}>
                    <span className="today-loop-title">{loop.title}</span>
                    <span className="today-loop-due">{dueLabel(t, loop)}</span>
                  </button>
                  <button
                    className="today-loop-done"
                    data-testid="today-loop-done"
                    title={t('today.loopDoneTitle')}
                    aria-label={t('today.loopDoneTitle')}
                    onClick={() => void done(loop.id, loop.title)}
                  >
                    <Check size={13} />
                  </button>
                </div>
              ))}
            </div>
          )
        })
      )}
    </section>
  )
}
