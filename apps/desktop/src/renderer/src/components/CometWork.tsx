import { ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { LiveView } from './LiveView.js'
import { PressGate } from './PressGate.js'
import { Thinking } from './Thinking.js'
import { stepLabel } from '../lib/pendingStatus.js'
import { useApp } from '../state.js'

// What the comet is doing, while it does it: every step of the turn in the
// order it happened, and the page it is on. It stays put while the answer is
// written above it - watching the work is how a person knows to step in -
// and folds into one line once the turn is over. The page outlives the turn:
// a browser still open, or the last thing a closed one showed, is here to be
// looked at rather than gone. With neither steps nor page, it takes no room.

export function CometWork({ busy, status, since, lines, kept }: { busy: boolean; status: string; since?: number; lines: string[]; kept: string[] }) {
  const { pressAsk, t } = useApp()
  const waiting = pressAsk !== null
  const [open, setOpen] = useState(false)
  const shown = busy ? lines : kept
  return (
    <div className={busy ? 'comet-work' : 'comet-work done'} data-testid={busy ? 'comet-work' : 'comet-work-done'}>
      {busy && <Thinking label={status} since={since} testId="bots-thinking" />}
      {!busy && kept.length > 0 && (
        <button className="comet-work-toggle" data-testid="comet-work-toggle" onClick={() => setOpen(!open)}>
          {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
          {t('bots.workDone', { n: kept.length })}
        </button>
      )}
      {(busy || open) && shown.length > 0 && (
        <ol className="comet-work-lines" data-testid="bots-work-lines">
          {shown.map((line, i) => (
            <li key={`${i}-${line}`} className={busy && i === shown.length - 1 ? 'comet-work-line current' : 'comet-work-line'}>
              {stepLabel(t, line)}
            </li>
          ))}
        </ol>
      )}
      {/* The question comes with the page, and rides inside the view: its
          buttons have to sit above the page, not behind it. */}
      <LiveView keep open={waiting}>
        <PressGate />
      </LiveView>
    </div>
  )
}
