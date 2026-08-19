import { Globe, List, Loader2, Network, Orbit, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SyncStatusDto } from '../../../shared/types.js'
import type { SweepStatus } from '../state.js'
import type { StringKey, Translate } from '../i18n.js'
import { api } from '../api.js'
import { useApp } from '../state.js'
import { Icon } from './Icon.js'
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js'

function syncLabel(t: Translate, status: SyncStatusDto | null): string {
  if (!status || status.state === 'no-remote') return t('topbar.syncNone')
  if (status.state === 'error') return t('topbar.syncError')
  if (status.state === 'clean') return t('topbar.syncClean')
  const parts = []
  if (status.ahead > 0) parts.push(`↑${status.ahead}`)
  if (status.behind > 0) parts.push(`↓${status.behind}`)
  return parts.join(' ')
}

// The sweep status is rendered here from its data so it follows the language.
// The 'error' variant is main-process text and is shown verbatim.
function sweepLabel(t: Translate, status: SweepStatus): string {
  switch (status.kind) {
    case 'running':
      return t('topbar.sweepRunning')
    case 'done':
      // "Tidy complete" over 40 items the librarian never touched is the lie
      // this bar told every time a run halted. Say what stopped it.
      if (status.haltReason === 'quota') return t('topbar.sweepQuota', { n: status.deferred })
      if (status.haltReason === 'auth') return t('topbar.sweepAuth', { n: status.deferred })
      if (status.deferred > 0) return t('topbar.sweepDeferred', { n: status.deferred })
      return t('topbar.sweepDone', { executed: status.executed, skipped: status.skipped })
    case 'error':
      return status.message
    default:
      return ''
  }
}

// The one chrome strip: canvas tabs on the left, actions + quiet status on
// the right. Everything else lives on the canvas or in overlays.
export function TopBar({ onOpenSettings, onToggleChat, onOpenPalette }: {
  onOpenSettings(): void
  onToggleChat(): void
  onOpenPalette(): void
}) {
  const { activity, setActivity, engines, sweepStatus, filing, absorb, pendingWork, sweepJob, runSweep, errand, errandWall, answerErrandWall, openInbox, showToast, vaultReady, t } = useApp()
  const [sync, setSync] = useState<SyncStatusDto | null>(null)
  const [brief, setBrief] = useState<string | null>(null)
  const unswept = pendingWork.inbox + pendingWork.notes
  // Present but not usable — the dot must not claim otherwise.
  const degradedEngine = engines.find((engine) => engine.healthy === false)
  const degraded = degradedEngine !== undefined
  const degradedTitle = degradedEngine
    ? degradedEngine.healthReason === 'quota'
      ? t('banner.quota', { ids: degradedEngine.id })
      : degradedEngine.healthReason === 'auth'
        ? t('banner.loginExpired', { ids: degradedEngine.id })
        : degradedEngine.healthReason === 'network'
          ? t('banner.offline', { ids: degradedEngine.id })
          : degradedEngine.healthReason === 'timeout'
            ? t('banner.tooSlow', { ids: degradedEngine.id })
            : t('banner.notResponding', { ids: degradedEngine.id })
    : ''
  // The diagnostics/reconnect overlay is owned by the shell (so the chat panel
  // can open it too); opening it is a shell-level window event.
  const openDiagnostics = () => window.dispatchEvent(new Event('engram:open-diagnostics'))
  // Sweep/absorb progress now lives in shared state (single source); the TopBar
  // owns only sync status, which nothing else consumes.
  const job = sweepJob?.job ?? null

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

  // Map the live job code onto its label; anything unexpected is dropped.
  const jobKey: StringKey | null = job && /^J[1-8]$/.test(job) ? (`topbar.job${job}` as StringKey) : null
  const jobSuffix = jobKey ? ` · ${t(jobKey)}` : ''
  // While a sweep is draining the absorb queue, that bar owns the description;
  // the sweep line is then just the spinner.
  const absorbing = absorb.pending > 0 && sweepStatus.running
  // A capture being filed (realtime J1) shows as its own live line whenever a
  // sweep isn't already narrating — otherwise a first capture organizes in
  // total silence for a minute and the app reads as broken.
  const filingOnly = filing && !sweepStatus.running
  const sweepText = filingOnly
    ? t('topbar.filing')
    : absorbing
      ? ''
      : sweepLabel(t, sweepStatus) + (sweepStatus.running ? jobSuffix : '')
  // A delegated errand narrates in this same slot — one parameterized line
  // ("Errand: gathering…"). It takes the slot while running because it is the
  // user's own foreground request; only the four working phases have a label.
  const errandPhaseKey: Record<string, StringKey> = {
    plan: 'topbar.errandPlan',
    gather: 'topbar.errandGather',
    web: 'topbar.errandWeb',
    distill: 'topbar.errandDistill',
    compose: 'topbar.errandCompose',
  }
  const errandKey = errand.phase ? errandPhaseKey[errand.phase] : undefined
  const errandText = errand.running && errandKey ? t('topbar.errand', { phase: t(errandKey) }) : ''
  // No engine = nothing is absorbing — say what the queue is actually
  // waiting for instead of a frozen "absorbing 0/N".
  const absorbText =
    (engines.length === 0
      ? t('absorb.waitingEngine', { n: absorb.pending })
      : t('topbar.absorbing', { done: absorb.total - absorb.pending, total: absorb.total })) +
    (sweepStatus.running ? jobSuffix : '')

  return (
    <header className="topbar" data-testid="topbar">
      <WorkspaceSwitcher />

      <nav className="canvas-tabs" aria-label={t('topbar.canvas')}>
        <button
          className={`canvas-tab${activity === 'sky' ? ' active' : ''}`}
          data-testid="activity-sky"
          onClick={() => setActivity('sky')}
        >
          <Orbit size={14} strokeWidth={1.8} aria-hidden /> {t('topbar.tabSky')}
        </button>
        <button
          className={`canvas-tab${activity === 'brain' ? ' active' : ''}`}
          data-testid="activity-brain"
          onClick={() => setActivity('brain')}
        >
          <Network size={14} strokeWidth={1.8} aria-hidden /> {t('topbar.tabBrain')}
        </button>
        <button
          className={`canvas-tab${activity === 'list' ? ' active' : ''}`}
          data-testid="activity-list"
          onClick={() => setActivity('list')}
        >
          <List size={14} strokeWidth={1.8} aria-hidden /> {t('activity.list')}
        </button>
      </nav>

      <div className="topbar-spacer" />

      <span className="topbar-status live" data-testid="sweep-status" title={(errandText || sweepText) || undefined}>
        {(errand.running || sweepStatus.running || filingOnly) && <Loader2 className="spin" size={12} aria-hidden />}
        <span className="status-label">{errandText || sweepText}</span>
      </span>
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
      {absorb.pending > 0 && (
        <span className="topbar-status live" data-testid="absorb-status" title={absorbText}>
          <span className="status-label">{absorbText}</span>
        </span>
      )}
      {/* engine status — one click straight to connect/diagnose */}
      {/* The most-seen engine claim in the app. It used to key off array length
          alone, so it stayed green — and read "AI connected" — through an
          expired token, a failed ping and a quota lockout, inches from a banner
          saying the opposite. The amber state already had CSS; it just was
          never wired to the verdict the app had all along. */}
      <button
        className={`topbar-status as-button engine-status${engines.length === 0 ? ' needs-engine' : ''}`}
        data-testid="engine-status"
        title={
          engines.length === 0
            ? t('topbar.engineConnect')
            : degraded
              ? degradedTitle
              : t('topbar.engineConnected', { ids: engines.map((e) => e.id).join(', ') })
        }
        onClick={openDiagnostics}
      >
        <span className={`engine-dot${engines.length === 0 ? '' : degraded ? ' warn' : ' on'}`} />
        {engines.length > 0 ? engines[0]!.id : t('topbar.engineConnectShort')}
      </button>

      {/* Solo vaults have no remote — a "sync —" placeholder is chrome noise,
          so the button only exists once there is something to sync with. */}
      {sync && sync.state !== 'no-remote' && (
        <button className="topbar-status as-button" data-testid="sync-status" disabled={syncing} onClick={() => void onSyncClick()}>
          {syncLabel(t, sync)}
        </button>
      )}

      {/* Tidy carries the "not yet organized" count (inbox + unswept notes) so
          the user can SEE when there is something for the librarian to do. */}
      <button
        className="topbar-action zap"
        data-testid="sweep-button"
        disabled={sweepStatus.running}
        onClick={() => {
          // The tour says "click to review" about this badge. With no engine
          // a sweep can only throw a toast — show the waiting captures
          // instead; the inbox overlay carries its own connect-engine banner.
          if (engines.length === 0) openInbox()
          else void runSweep()
        }}
        title={unswept > 0 ? t('topbar.tidyPending', { n: unswept }) : t('topbar.tidyTitle')}
      >
        <Icon name="zap" size={14} /> {t('topbar.tidy')}
        {unswept > 0 && !sweepStatus.running && <span className="badge">{unswept > 99 ? '99+' : unswept}</span>}
      </button>

      <button className="topbar-action" data-testid="chat-toggle" onClick={onToggleChat} title={t('topbar.chatTitle')}>
        <Icon name="chat" size={15} />
      </button>
      <button className="topbar-action" onClick={onOpenPalette} title={t('topbar.searchTitle')}>
        <Icon name="search" size={15} />
      </button>
      <button
        className="topbar-action errands-action"
        data-testid="topbar-errands"
        onClick={() => window.dispatchEvent(new Event('engram:open-errand'))}
        title={t('topbar.errandsTitle')}
      >
        <Send size={15} strokeWidth={1.8} />
        {errand.running && <span className="errand-live-dot" aria-hidden />}
      </button>
      <button className="topbar-action" data-testid="activity-settings" onClick={onOpenSettings} title={t('topbar.settingsTitle')}>
        <Icon name="settings" size={15} />
      </button>

      {/* Today lives in TodayDock, floating inside the canvas — putting it in
          this bar sat it on top of the native window controls. */}

      {brief && (
        <div className="brief-overlay" onClick={() => setBrief(null)}>
          <div className="brief-box" onClick={(e) => e.stopPropagation()}>
            <div className="brief-title">{t('topbar.teamChanges')}</div>
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
