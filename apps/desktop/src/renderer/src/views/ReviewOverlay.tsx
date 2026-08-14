import { useEffect, useMemo } from 'react'
import type { StringKey } from '../i18n.js'
import { groupIssues } from '../lib/issues.js'
import { useApp } from '../state.js'
import { ReviewDetail } from './ReviewDetail.js'

const CARD_LABEL_KEY: Record<string, StringKey> = {
  'new-note': 'review.cardNewNote',
  supersede: 'review.cardSupersede',
  conflict: 'review.cardConflict',
  stale: 'review.cardStale',
  merge: 'review.cardMerge',
  chronology: 'review.cardChronology',
  closure: 'review.cardClosure',
}

// Review overlay: the librarian's question stack. Skim with ↑↓, act with
// A/R/E — same grammar as before, now it comes to you instead of being a
// place you go.
export function ReviewOverlay() {
  const { reviewOpen, closeReview, cards, notes, selectedCardId, selectCard, t } = useApp()
  const proposed = cards.filter((c) => c.status === 'proposed')
  // One row per ISSUE, not per card: sibling cards about the same notes fold
  // under a lead (answering any of them dismisses the rest, so ten cards
  // reading as ten questions was a lie about the actual work left).
  const issues = useMemo(() => groupIssues(proposed), [proposed])
  // Cards store target note IDS; the list must speak in titles — nobody
  // recognizes "n-mrghai4y-xyhs6y" as their vacation-form deadline note.
  const titleOf = useMemo(() => new Map(notes.map((n) => [n.id, n.title])), [notes])
  const targetLabel = (targets: string[]) => targets.map((id) => titleOf.get(id) ?? id).join(' · ')
  const activeId = selectedCardId ?? issues[0]?.lead.id

  useEffect(() => {
    if (!reviewOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeReview()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [reviewOpen, closeReview])

  // Keep the detail pane on the SAME card the list highlights: without an
  // explicit selection the detail falls back to proposed[0] (raw card order),
  // which may be a sibling buried under a different issue row.
  useEffect(() => {
    if (!reviewOpen) return
    const lead = issues[0]?.lead.id
    if (lead && (!selectedCardId || !proposed.some((c) => c.id === selectedCardId))) selectCard(lead)
  }, [reviewOpen, issues, selectedCardId, proposed, selectCard])

  if (!reviewOpen) return null

  return (
    <div className="sheet-overlay" onClick={closeReview}>
      <div className="review-sheet" data-testid="review-sheet" onClick={(e) => e.stopPropagation()}>
        <aside className="review-list">
          <div className="section-label">{t('review.questions', { count: issues.length })}</div>
          {issues.map(({ lead, siblings }) => {
            const labelKey = CARD_LABEL_KEY[lead.cardType]
            const groupIds = [lead.id, ...siblings.map((s) => s.id)]
            const selectedInGroup = groupIds.includes(activeId ?? '')
            return (
              <div key={lead.id} className={`issue-row${selectedInGroup ? ' selected' : ''}`}>
                <button className="side-item issue-lead" data-card-id={lead.id} onClick={() => selectCard(lead.id)}>
                  <span className="side-title">[{labelKey ? t(labelKey) : lead.cardType}] {targetLabel(lead.targets) || t('review.newTarget')}</span>
                  <span className="side-sub">{lead.rationale}</span>
                </button>
                {siblings.length > 0 && (
                  <div className="issue-siblings">
                    <span className="issue-siblings-note">{t('review.oneAnswer', { count: siblings.length })}</span>
                    {siblings.map((s) => {
                      const key = CARD_LABEL_KEY[s.cardType]
                      return (
                        <button
                          key={s.id}
                          className={`issue-chip${activeId === s.id ? ' selected' : ''}`}
                          onClick={() => selectCard(s.id)}
                        >
                          {key ? t(key) : s.cardType}
                        </button>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
          {issues.length === 0 && <div className="empty-hint">{t('review.empty')}</div>}
        </aside>
        <div className="review-main">
          <button className="sheet-close review-close" aria-label={t('review.closeReview')} onClick={closeReview}>
            ✕
          </button>
          <ReviewDetail />
        </div>
      </div>
    </div>
  )
}
