import { ArrowDown, ArrowUp } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { CardDetailDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { DiffView } from '../editor/DiffView.js'
import { overlapSiblings } from '../lib/issues.js'
import { useApp } from '../state.js'

// Review flow: A approve · R reject · E edit-proposal · ↑↓ move.
// Approving advances straight to the next card.
export function ReviewDetail() {
  const { cards, selectedCardId, selectCard, refresh, showToast, t } = useApp()
  const proposed = cards.filter((c) => c.status === 'proposed')
  const current = proposed.find((c) => c.id === selectedCardId) ?? proposed[0] ?? null
  const [detail, setDetail] = useState<CardDetailDto | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!current) {
      setDetail(null)
      return
    }
    setEditing(false)
    setRejecting(false)
    setReason('')
    void api.cardDetail(current.id).then((d) => {
      setDetail(d)
      setDraft(d.card.proposed)
    })
  }, [current?.id]) // deliberately keyed on the card id only

  const advance = useCallback(
    (fromId: string) => {
      const rest = proposed.filter((c) => c.id !== fromId)
      selectCard(rest[0]?.id ?? null)
    },
    [proposed, selectCard],
  )

  const approve = useCallback(
    async (options: { choice?: 'A' | 'B' | 'both'; action?: 'keep' | 'retire' } = {}) => {
      if (!current) return
      // Approval auto-dismisses sibling questions about the same notes —
      // say so, or cards vanishing from the stack reads as a glitch.
      const folded = overlapSiblings(current, proposed)
      await api.approveCard(current.id, { ...options, proposed: editing ? draft : undefined })
      showToast(
        folded.length > 0
          ? t('toast.approvedIssue', { count: folded.length })
          : t('toast.approved', { type: current.cardType }),
      )
      // Advance past the WHOLE issue — its siblings are already dismissed.
      const gone = new Set([current.id, ...folded.map((c) => c.id)])
      selectCard(proposed.find((c) => !gone.has(c.id))?.id ?? null)
      await refresh()
    },
    [current, proposed, editing, draft, selectCard, refresh, showToast, t],
  )

  const confirmReject = useCallback(async () => {
    if (!current) return
    await api.rejectCard(current.id, reason.trim() || 'No reason given')
    showToast(t('toast.rejected'))
    setRejecting(false)
    setReason('')
    advance(current.id)
    await refresh()
  }, [current, reason, advance, refresh, showToast, t])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return
      if (e.key === 'a' || e.key === 'A') void approve()
      else if (e.key === 'r' || e.key === 'R') setRejecting(true)
      else if (e.key === 'e' || e.key === 'E') setEditing((v) => !v)
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!current) return
        const idx = proposed.findIndex((c) => c.id === current.id)
        const next = proposed[e.key === 'ArrowDown' ? idx + 1 : idx - 1]
        if (next) selectCard(next.id)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [approve, current, proposed, selectCard])

  if (!current || !detail) return <div className="empty-view">{t('review.empty')}</div>

  const { card, targets } = detail
  const first = targets[0]
  // The keys hint carries the ↑↓ move affordance as inline icons ({arrows}).
  const [keysBefore, keysAfter = ''] = t('review.keys').split('{arrows}')

  return (
    <div className="review-detail" data-testid="review-detail">
      <header className="review-header">
        <span className="review-type">{card.cardType}</span>
        <span className="review-rationale">{card.rationale}</span>
        <span className="review-keys">
          {keysBefore}
          <ArrowUp size={11} strokeWidth={1.8} aria-hidden />
          <ArrowDown size={11} strokeWidth={1.8} aria-hidden />
          {keysAfter}
        </span>
      </header>

      {editing ? (
        <textarea className="proposal-edit" value={draft} onChange={(e) => setDraft(e.target.value)} rows={12} />
      ) : (
        <>
          {(card.cardType === 'supersede' || card.cardType === 'merge' || card.cardType === 'new-note') && (
            <DiffView
              left={first?.body ?? ''}
              right={card.proposed}
              leftLabel={first ? t('review.diffCurrent', { title: first.title }) : t('review.diffNew')}
              rightLabel={t('review.diffProposed')}
            />
          )}
          {card.cardType === 'conflict' && targets.length >= 2 && (
            <DiffView
              left={targets[0]!.body}
              right={targets[1]!.body}
              leftLabel={t('review.diffA', { title: targets[0]!.title })}
              rightLabel={t('review.diffB', { title: targets[1]!.title })}
            />
          )}
          {(card.cardType === 'stale' || card.cardType === 'chronology') && (
            <pre className="card-plain">{first?.body || card.proposed}</pre>
          )}
        </>
      )}

      {rejecting && (
        <div className="reject-form">
          <input
            autoFocus
            placeholder={t('review.rejectPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void confirmReject()}
          />
          <button className="primary" onClick={() => void confirmReject()}>
            {t('review.confirmReject')}
          </button>
          <button className="secondary" onClick={() => setRejecting(false)}>
            {t('review.cancel')}
          </button>
        </div>
      )}

      <footer className="review-actions">
        {card.cardType === 'conflict' ? (
          <>
            <button className="primary" data-testid="approve-a" onClick={() => void approve({ choice: 'A' })}>
              {t('review.keepA')}
            </button>
            <button className="primary" onClick={() => void approve({ choice: 'B' })}>
              {t('review.keepB')}
            </button>
            <button className="secondary" onClick={() => void approve({ choice: 'both' })}>
              {t('review.keepBoth')}
            </button>
          </>
        ) : card.cardType === 'stale' ? (
          <>
            <button className="primary" onClick={() => void approve({ action: 'keep' })}>
              {t('review.stillValid')}
            </button>
            <button className="secondary" onClick={() => void approve({ action: 'retire' })}>
              {t('review.retire')}
            </button>
          </>
        ) : (
          <button className="primary" data-testid="approve" onClick={() => void approve()}>
            {t('review.approve')}
          </button>
        )}
        <button className="secondary" data-testid="reject" onClick={() => setRejecting(true)}>
          {t('review.reject')}
        </button>
        <button className="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? t('review.doneEditing') : t('review.edit')}
        </button>
      </footer>
    </div>
  )
}
