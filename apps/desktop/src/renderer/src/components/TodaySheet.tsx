import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { FadingMemoryDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { renderMarkdown } from '../lib/markdown.js'
import { useApp } from '../state.js'
import { TodayLoops } from './TodayLoops.js'

// Today sheet: a right-side slide-over (mirrors NoteSheet's scrim + Escape/✕
// close). Two halves, live first — what is still open (read from the vault on
// every change), then the latest librarian brief and the activity feed.
// Owns its own brief fetch: on open, when a sweep finishes, and on demand.
// The weekly digest used to render below the brief; it moved to its own sheet
// (DigestSheet) because a week-long retrospective is a different question at a
// different cadence, and it buried the morning.
export function TodaySheet() {
  const { todayOpen, closeToday, openNote, refresh, t } = useApp()
  const [brief, setBrief] = useState<string | null>(null)
  const [desk, setDesk] = useState<{ totalMs: number; apps: { app: string; ms: number; topTitles: string[] }[] } | null>(null)
  const [fading, setFading] = useState<FadingMemoryDto[]>([])
  // Fresh each time the sheet opens — a day-long-mounted component fetching
  // once at boot would show the morning forever.
  useEffect(() => {
    if (!todayOpen) return
    void api.activityToday().then(setDesk).catch(() => {})
    void api.fadingMemories().then(setFading).catch(() => setFading([]))
  }, [todayOpen])

  // The brief is a FILE the librarian rewrites during a sweep, so unlike the
  // open loops (which follow vault:changed) it can go stale under a sheet that
  // is already open — and this sheet is meant to be left open in the morning,
  // which is exactly when a Tidy lands behind it.
  const [busy, setBusy] = useState(false)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)

  const reloadBrief = useCallback(() => {
    void api.latestBrief().then(setBrief)
  }, [])

  // Both halves at once, and held long enough to be seen. Reading a file and
  // re-listing notes is near-instant, so without the floor the spinner would
  // flash for a frame and the click would look ignored.
  const doRefresh = useCallback(async () => {
    setBusy(true)
    try {
      // refreshBrief, not latestBrief: the librarian re-reads the vault and
      // rewrites the paragraph. Re-reading the file alone gave back prose
      // written against an older vault, which is what made this feel like a
      // fetch rather than an assistant. It costs an engine call only when the
      // brief's own inputs changed — core skips it otherwise.
      await Promise.all([
        api.refreshBrief().then(setBrief).catch(() => undefined),
        refresh(),
        new Promise((r) => setTimeout(r, 450)),
      ])
      setCheckedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
    } finally {
      setBusy(false)
    }
  }, [refresh])

  useEffect(() => {
    if (!todayOpen) return
    reloadBrief()
  }, [todayOpen, reloadBrief])

  // A finished sweep is the only thing that can rewrite the brief.
  useEffect(() => {
    if (!todayOpen) return
    return api.onEvent((event) => {
      if (event.type === 'sweep:done') reloadBrief()
    })
  }, [todayOpen, reloadBrief])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeToday()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [closeToday])

  if (!todayOpen) return null

  const date = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="sheet-overlay today-overlay" onClick={closeToday}>
      <div className="today-sheet" data-testid="today-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <div className="today-heading">
            <span className="today-title">{t('today.title')}</span>
            <span className="today-date">{checkedAt ? t('today.checkedAt', { time: checkedAt }) : date}</span>
          </div>
          <button
            className={`today-refresh${busy ? ' busy' : ''}`}
            data-testid="today-refresh"
            disabled={busy}
            title={t('today.refresh')}
            onClick={() => void doRefresh()}
          >
            <RefreshCw size={13} strokeWidth={2} aria-hidden />
            {t('today.refresh')}
          </button>
          <button className="sheet-close" aria-label={t('today.close')} onClick={closeToday}>
            ✕
          </button>
        </div>
        <div className="today-body">
          {busy ? (
            <div className="today-skeleton" data-testid="today-refreshing" aria-busy="true">
              <div className="today-refreshing">
                <RefreshCw size={13} strokeWidth={2} className="spin" aria-hidden />
                {t('today.refreshing')}
              </div>
              {/* Shaped like the answer it is standing in for — one heading, a
                  few lines — so the layout does not jump when the real text
                  lands. Widths vary because equal bars read as a progress
                  meter rather than as text. */}
              <div className="skeleton-bar head" />
              {[92, 78, 85, 64].map((w) => (
                <div key={w} className="skeleton-bar" style={{ width: `${w}%` }} />
              ))}
              <div className="skeleton-bar head short" />
              {[70, 88, 60].map((w) => (
                <div key={w} className="skeleton-bar" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : (
            <>
              {desk && desk.apps.length > 0 && (
                <section className="today-desk" data-testid="today-desk">
                  <div className="today-desk-total">
                    {t('today.deskTotal', { hours: (desk.totalMs / 3_600_000).toFixed(1) })}
                  </div>
                  {desk.apps.map((row) => (
                    <div key={row.app} className="today-desk-row">
                      <span className="today-desk-app">{row.app}</span>
                      <span className="today-desk-hours">{(row.ms / 3_600_000).toFixed(1)}h</span>
                      <span className="today-desk-titles">{row.topTitles.slice(0, 2).join(' · ')}</span>
                    </div>
                  ))}
                </section>
              )}
              {brief ? (
                <article className="brief" data-testid="brief">
                  {renderMarkdown(brief)}
                </article>
              ) : (
                <p className="today-quiet today-no-brief">{t('today.empty')}</p>
              )}
              <TodayLoops />
              {fading.length > 0 && (
                <section className="today-fading" data-testid="today-fading">
                  <div className="today-section-head">{t('today.fadingHead')}</div>
                  {fading.map((f) => (
                    <button key={f.id} className="today-fading-row" onClick={() => openNote(f.id)}>
                      <span className="today-fading-title">{f.title}</span>
                      <span className="today-fading-days">{t('today.fadingDays', { n: String(f.daysQuiet) })}</span>
                    </button>
                  ))}
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
