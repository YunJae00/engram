import { useMemo } from 'react'
import { BrainGraph } from '../components/TopicGraph.js'
import { useApp } from '../state.js'

// Starter chips double as the empty sky's "what do I even capture?" answer,
// floated over the dark.
const STARTER_EXAMPLES = [
  { label: 'starter.ex1', seed: 'starter.ex1Seed' },
  { label: 'starter.ex2', seed: 'starter.ex2Seed' },
  { label: 'starter.ex3', seed: 'starter.ex3Seed' },
] as const

export function SkyView({
  focus,
  onFocusConsumed,
}: {
  // Star ids to spotlight on arrival ("View in the cosmos" hand-off) —
  // consumed once so revisiting the tab doesn't relight an old topic.
  focus?: { ids: string[] } | null
  onFocusConsumed?: () => void
}) {
  const { notes, openNote, t } = useApp()
  const live = useMemo(
    () => notes.filter((n) => n.status === 'current' || n.status === 'disputed'),
    [notes],
  )

  // No container measuring: the graph solves in its own virtual space and the
  // viewBox scales it, so a resize is pure SVG scaling — no observer, no
  // re-layout, no state churn.
  return (
    <div className="sky-view" data-testid="sky-view">
      {live.length > 0 && (
        <BrainGraph notes={live} onOpen={openNote} focus={focus} onFocusConsumed={onFocusConsumed} />
      )}
      {live.length === 0 && (
        <div className="sky-empty" data-testid="sky-starter">
          <div className="sky-empty-title">{t('sky.empty')}</div>
          <div className="sky-empty-hint">{t('sky.emptyHint')}</div>
          <div className="starter-try sky-try">
            <span className="starter-try-label">{t('starter.try')}</span>
            {STARTER_EXAMPLES.map(({ label, seed }) => (
              <button
                key={label}
                className="starter-chip"
                data-testid={`sky-chip-${label.slice(-3)}`}
                onClick={() =>
                  window.dispatchEvent(new CustomEvent('engram:focus-capture', { detail: { seed: t(seed) } }))
                }
              >
                {t(label)}
              </button>
            ))}
          </div>
          <button
            className="starter-import"
            data-testid="sky-import"
            onClick={() => window.dispatchEvent(new Event('engram:open-import'))}
          >
            {t('starter.import')}
          </button>
        </div>
      )}
      {live.length > 0 && (
        <div className="sky-legend" aria-hidden>
          <span className="sky-legend-item"><span className="sky-dot bright" /> {t('sky.legendFresh')}</span>
          <span className="sky-legend-item"><span className="sky-dot dim" /> {t('sky.legendFading')}</span>
          <span className="sky-legend-item"><span className="sky-dot halo" /> {t('sky.legendRecalled')}</span>
        </div>
      )}
    </div>
  )
}
