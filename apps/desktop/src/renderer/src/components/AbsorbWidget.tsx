import { Loader2, Minus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { StringKey } from '../i18n.js'
import { useApp } from '../state.js'

// Floating librarian-progress widget (fixed, bottom-left).
// Visible while a sweep runs or the absorb queue still holds
// pending items. It is the liveness signal for the long-running sweep: a stage
// line, a progress bar, and an elapsed ticker that keeps moving every second.
const FOLD_KEY = 'engram.absorb.folded'

export function AbsorbWidget() {
  const { sweepStatus, sweepJob, sweepStartedAt, absorb, engines, runSweep, t } = useApp()
  // With no engine, "Resume" is a lie — the queue can't drain. Say what's
  // actually blocking and route to the connect overlay instead (QA5 field
  // note: a novice would click Resume forever after an offline import).
  const noEngine = engines.length === 0
  // Quota is the same shape as no-engine and was simply missed: after a halted
  // sweep the widget said "Paused — 40 waiting" with a [Resume] button that
  // could only re-hit the same limit, forever, without ever naming it.
  const halt = sweepStatus.kind === 'done' ? sweepStatus.haltReason : undefined
  const openDiagnostics = () => window.dispatchEvent(new Event('engram:open-diagnostics'))
  const running = sweepStatus.running
  // A run is actively draining the queue vs. just finished (bar at 100%). The
  // completion state lives only for state.tsx's brief reset window, after which
  // absorb resets to {0,0} and this widget hides (unless a sweep is still on).
  const draining = absorb.total > 0 && absorb.pending > 0
  const complete = absorb.total > 0 && absorb.pending === 0
  const paused = draining && !running

  // Quiet dismiss: hide until the next sweep:start (running) or import:progress
  // with pending>0 (draining) — both re-clear the flag via the effect below.
  const [dismissed, setDismissed] = useState(false)
  // Folded is a preference, not a session state: someone who folded this once
  // does not want it unfolding itself every time the librarian wakes.
  const [folded, setFolded] = useState(() => localStorage.getItem(FOLD_KEY) === '1')
  const foldTo = (next: boolean) => {
    localStorage.setItem(FOLD_KEY, next ? '1' : '0')
    setFolded(next)
  }
  useEffect(() => {
    if (running || absorb.pending > 0) setDismissed(false)
  }, [running, absorb.pending])

  // Elapsed ticker (mm:ss since the active sweep:start) — only while running.
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!running || sweepStartedAt === null) {
      setElapsed(0)
      return
    }
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - sweepStartedAt) / 1000)))
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [running, sweepStartedAt])

  const visible = !dismissed && (running || draining || complete)
  if (!visible) return null

  const done = Math.max(0, absorb.total - absorb.pending)
  const percent = absorb.total > 0 ? Math.round((done / absorb.total) * 100) : 0
  const jobKey: StringKey | null =
    sweepJob && /^J[1-8]$/.test(sweepJob.job) ? (`topbar.job${sweepJob.job}` as StringKey) : null
  const mm = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const ss = String(elapsed % 60).padStart(2, '0')

  if (folded) {
    return (
      <button
        className="absorb-widget folded"
        data-testid="absorb-widget"
        title={t('absorb.title')}
        onClick={() => foldTo(false)}
      >
        {/* A halted queue must not hide behind a green dot: paused shows
            amber and the waiting count, so the fold never buries a problem. */}
        {running ? (
          <span className="absorb-ring" aria-hidden />
        ) : (
          <span className={`absorb-dot${paused ? ' paused' : ''}`} />
        )}
        <span>
          {paused
            ? t('absorb.pillPaused', { n: absorb.pending })
            : draining
              ? `${done}/${absorb.total}`
              : t('absorb.title')}
        </span>
      </button>
    )
  }

  return (
    <div className="absorb-widget" data-testid="absorb-widget">
      <div className="absorb-head">
        {running ? (
          <>
            <Loader2 className="spin" size={13} strokeWidth={1.8} aria-hidden />
            <span className="absorb-title">{t('absorb.title')}</span>
          </>
        ) : paused ? (
          <span className="absorb-title">
            {noEngine
              ? t('absorb.waitingEngine', { n: absorb.pending })
              : halt === 'quota'
                ? t('absorb.quotaPaused', { n: absorb.pending })
                : halt === 'auth'
                  ? t('absorb.authPaused', { n: absorb.pending })
                  : t('absorb.paused', { n: absorb.pending })}
          </span>
        ) : (
          <span className="absorb-title">{t('absorb.done')}</span>
        )}
        <span className="absorb-controls">
          <button
            className="absorb-fold"
            data-testid="absorb-fold"
            aria-label={t('absorb.minimize')}
            onClick={() => foldTo(true)}
          >
            <Minus size={12} strokeWidth={1.8} aria-hidden />
          </button>
          <button
            className="absorb-dismiss"
            data-testid="absorb-dismiss"
            aria-label={t('absorb.dismiss')}
            onClick={() => setDismissed(true)}
          >
            <X size={12} strokeWidth={1.8} aria-hidden />
          </button>
        </span>
      </div>

      {draining && (
        <div className="absorb-progress">
          <div className="absorb-track">
            <div className="absorb-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="absorb-caption">
            {done}/{absorb.total} · {percent}%
          </div>
        </div>
      )}

      {running && jobKey && sweepJob && (
        <div className="absorb-stage">
          {sweepJob.index}/{sweepJob.total} · {t(jobKey)}
        </div>
      )}

      {running && (
        <div className="absorb-elapsed" data-testid="absorb-elapsed">
          {mm}:{ss}
        </div>
      )}

      {/* Nothing is lost — say so, because a stalled progress bar reads as
          "my import disappeared" and the deferred batch was in fact put back. */}
      {paused && halt === 'quota' && <div className="absorb-stage">{t('absorb.quotaHint')}</div>}

      {(running || paused) && (
        <div className="absorb-actions">
          {running ? (
            <button className="absorb-btn" data-testid="absorb-stop" onClick={() => void api.absorbStop()}>
              {t('absorb.stop')}
            </button>
          ) : noEngine ? (
            <button className="absorb-btn primary" onClick={openDiagnostics}>
              {t('topbar.engineConnectShort')}
            </button>
          ) : halt === 'auth' ? (
            <button className="absorb-btn primary" onClick={openDiagnostics}>
              {t('absorb.login')}
            </button>
          ) : halt === 'quota' ? null : (
            <button className="absorb-btn primary" onClick={() => void runSweep()}>
              {t('absorb.resume')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
