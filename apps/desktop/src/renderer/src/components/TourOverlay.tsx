import { useEffect, useState } from 'react'
import { useApp } from '../state.js'

export const TOUR_DONE_KEY = 'engram.tour.done'

// `as const` keeps each key literal, so the `tour.${key}Title` template
// resolves to exact i18n keys and stays compile-checked.
const STEPS = [
  { anchor: null, key: 'welcome' },
  { anchor: '[data-testid="activity-sky"]', key: 'cosmos' },
  { anchor: '[data-testid="remember-button"]', key: 'capture' },
  { anchor: '[data-testid="sweep-button"]', key: 'tidy' },
  { anchor: '[data-testid="activity-brain"]', key: 'brain' },
] as const

const PAD = 6
const CARD_W = 320

export function TourOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useApp()
  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)

  const current = STEPS[step]!
  const finish = () => {
    localStorage.setItem(TOUR_DONE_KEY, '1')
    onClose()
  }

  // Anchor tracking: re-measure on step change and window resize. A missing
  // anchor (layout variant) degrades to the centered card, never a crash.
  useEffect(() => {
    const measure = () => {
      if (!current.anchor) return setRect(null)
      const el = document.querySelector(current.anchor)
      setRect(el ? el.getBoundingClientRect() : null)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [current.anchor])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish()
      if (e.key === 'Enter' || e.key === 'ArrowRight') setStep((s) => Math.min(s + 1, STEPS.length - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, []) // finish/step-advance identities are stable enough for the tour's lifetime

  const last = step === STEPS.length - 1
  // Card placement: below the anchor when it lives in the top half (top bar),
  // above when it floats at the bottom (capture dock); clamped horizontally.
  const cardStyle: React.CSSProperties = rect
    ? {
        left: Math.max(12, Math.min(window.innerWidth - CARD_W - 12, rect.left + rect.width / 2 - CARD_W / 2)),
        ...(rect.top < window.innerHeight / 2
          ? { top: rect.bottom + PAD + 14 }
          : { bottom: window.innerHeight - rect.top + PAD + 14 }),
      }
    : { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' }

  return (
    <div className={`tour-overlay${rect ? '' : ' dimmed'}`} data-testid="tour-overlay">
      {rect && (
        <div
          className="tour-highlight"
          style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }}
        />
      )}
      <div className="tour-card" style={cardStyle} data-testid="tour-card">
        <div className="tour-title">{t(`tour.${current.key}Title`)}</div>
        <div className="tour-body">{t(`tour.${current.key}Body`)}</div>
        <div className="tour-foot">
          <div className="tour-dots" aria-hidden>
            {STEPS.map((_, i) => (
              <span key={i} className={i === step ? 'active' : ''} />
            ))}
          </div>
          <div className="tour-actions">
            {!last && (
              <button className="tour-skip" data-testid="tour-skip" onClick={finish}>
                {t('tour.skip')}
              </button>
            )}
            <button
              className="tour-next"
              data-testid="tour-next"
              onClick={() => (last ? finish() : setStep(step + 1))}
            >
              {last ? t('tour.start') : t('tour.next')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
