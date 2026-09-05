import { Globe, PanelLeftOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SyncStatusDto } from '../../../shared/types.js'
import { t, type Translate } from '../i18n.js'
import { api } from '../api.js'
import { useTopBarState } from '../state-slices.js'
import { DialogHeader } from './DialogHeader.js'

function syncLabel(t: Translate, status: SyncStatusDto | null): string {
  if (!status || status.state === 'no-remote') return t('topbar.syncNone')
  if (status.state === 'error') return t('topbar.syncError')
  if (status.state === 'clean') return t('topbar.syncClean')
  const parts = []
  if (status.ahead > 0) parts.push(`↑${status.ahead}`)
  if (status.behind > 0) parts.push(`↓${status.behind}`)
  return parts.join(' ')
}

// The title strip keeps the current view visible without competing with its
// content header. Ongoing work is grouped with the engine in the sidebar.
export function TopBar({ sidebarOpen, onToggleSidebar }: {
  sidebarOpen: boolean
  onToggleSidebar(): void
}) {
  const { activity, errandWall, answerErrandWall, showToast, vaultReady } = useTopBarState()
  const [sync, setSync] = useState<SyncStatusDto | null>(null)
  const [brief, setBrief] = useState<string | null>(null)
  useEffect(() => {
    // The window now paints BEFORE the vault finishes opening (deliberately —
    // see openVaultContext), and sync:status only exists once registerTeamIpc
    // has run. Polling ahead of that logged an unhandled main-process error on
    // every cold start and left the badge blank until the next tick, 60s later.
    if (!vaultReady) return
    const refreshSync = () => {
      void api.syncStatus().then(setSync).catch(() => setSync(null))
    }
    refreshSync()
    const timer = window.setInterval(refreshSync, 60_000)
    // vault:changed fires once per captured file — a 23-file drop meant 23
    // back-to-back `git status` calls. Coalesce a burst into one trailing call.
    let debounce: number | null = null
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== 'vault:changed') return
      if (debounce !== null) window.clearTimeout(debounce)
      debounce = window.setTimeout(() => {
        debounce = null
        refreshSync()
      }, 1_000)
    })
    return () => {
      window.clearInterval(timer)
      if (debounce !== null) window.clearTimeout(debounce)
      unsubscribe()
    }
  }, [vaultReady])

  const [syncing, setSyncing] = useState(false)
  const onSyncClick = async () => {
    if (syncing) return
    setSyncing(true)
    try {
      if (sync?.state === 'behind' || sync?.state === 'diverged') {
        setBrief(await api.syncBrief())
      } else if (sync && sync.state !== 'no-remote') {
        const result = await api.syncNow()
        setSync(result)
        showToast(result.conflictCards ? t('toast.syncedConflicts', { count: result.conflictCards }) : t('toast.synced'))
      } else {
        showToast(t('toast.noTeam'))
      }
    } catch (err) {
      // A rejected pull/push used to be swallowed: the button simply did nothing.
      showToast(t('toast.syncFailed', { reason: String((err as Error).message ?? err).slice(0, 120) }))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <header className="topbar" data-testid="topbar">
      {!sidebarOpen && (
        <button className="topbar-sidebar-toggle" data-testid="app-sidebar-open" title={t('rail.show')} onClick={onToggleSidebar}>
          <PanelLeftOpen size={17} strokeWidth={1.8} aria-hidden />
        </button>
      )}
      <span className="topbar-title">
        {activity === 'bots' ? t('topbar.tabBots') : activity === 'sky' ? t('topbar.tabSky') : t('activity.list')}
      </span>

      <div className="topbar-spacer" />

      {errandWall && (
        <span className="topbar-status live errand-wall" data-testid="errand-wall" title={errandWall.url}>
          <Globe size={12} strokeWidth={1.8} aria-hidden />
          <span className="status-label">
            {t(errandWall.wall === 'captcha' ? 'errand.wallCaptcha' : 'errand.wallLogin')}
          </span>
          <button className="errand-wall-done" data-testid="errand-wall-done" onClick={() => answerErrandWall('resolved')}>
            {t('errand.wallDone')}
          </button>
          <button className="errand-wall-skip" data-testid="errand-wall-skip" onClick={() => answerErrandWall('skip')}>
            {t('errand.wallSkip')}
          </button>
        </span>
      )}
      {/* Solo vaults have no remote — a "sync —" placeholder is chrome noise,
          so the button only exists once there is something to sync with. */}
      {sync && sync.state !== 'no-remote' && (
        <button className="topbar-status as-button" data-testid="sync-status" disabled={syncing} onClick={() => void onSyncClick()}>
          {syncLabel(t, sync)}
        </button>
      )}
      {/* Today lives in TodayDock, floating inside the canvas — putting it in
          this bar sat it on top of the native window controls. */}

      {brief && (
        <div className="brief-overlay" onClick={() => setBrief(null)}>
          <div className="brief-box" onClick={(e) => e.stopPropagation()}>
            <DialogHeader closeLabel={t('topbar.close')} onClose={() => setBrief(null)}>{t('topbar.teamChanges')}</DialogHeader>
            <pre className="brief-text">{brief}</pre>
            <button className="primary" onClick={() => setBrief(null)}>
              {t('topbar.close')}
            </button>
          </div>
        </div>
      )}
    </header>
  )
}
