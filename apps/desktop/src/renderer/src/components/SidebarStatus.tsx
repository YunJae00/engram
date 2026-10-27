import { Check, CircleAlert, LoaderCircle, RotateCw } from 'lucide-react'
import { useRef, useState } from 'react'
import { api, apiErrorText } from '../api.js'
import type { SweepStatus } from '../state.js'
import { t, type StringKey, type Translate } from '../i18n.js'
import { useShellState, useTopBarState } from '../state-slices.js'
import { connectionConfirmed } from '../lib/connectionStatus.js'

function sweepLabel(translate: Translate, status: SweepStatus): string {
  switch (status.kind) {
    case 'running':
      return translate('topbar.sweepRunning')
    case 'done':
      if (status.haltReason === 'quota') return translate('topbar.sweepQuota', { n: status.deferred })
      if (status.haltReason === 'auth') return translate('topbar.sweepAuth', { n: status.deferred })
      if (status.haltReason === 'outage') return translate('topbar.sweepOutage', { n: status.deferred })
      if (status.deferred > 0) return translate('topbar.sweepDeferred', { n: status.deferred })
      return translate('topbar.sweepDone', { executed: status.executed, skipped: status.skipped })
    case 'error':
      return /No engine available/.test(status.message) ? 'Filing AI unavailable' : apiErrorText(status.message)
    default:
      return ''
  }
}

export function SidebarStatus() {
  const { engines, sweepStatus, filing, absorb, sweepJob, errand, vaultReady, showToast } = useTopBarState()
  const { enginesDetected } = useShellState()
  const [retrying, setRetrying] = useState(false)
  const pending = useRef(false)
  const retry = async () => {
    if (pending.current) return
    pending.current = true; setRetrying(true)
    try { if (!engines.some(engine => connectionConfirmed(engine) && engine.healthy !== false)) await api.aiCheck(); await api.sweep() }
    catch (error) { const message = apiErrorText(error instanceof Error ? error.message : String(error)); showToast(/No engine available/.test(message) ? 'Filing is paused. Choose a connected AI for filing in Settings.' : message) }
    finally { pending.current = false; setRetrying(false) }
  }
  const jobKey: StringKey | null = sweepJob?.job && /^J[1-8]$/.test(sweepJob.job) ? (`topbar.job${sweepJob.job}` as StringKey) : null
  const jobSuffix = jobKey ? ` · ${t(jobKey)}` : ''
  const filingOnly = filing && !sweepStatus.running
  const absorbing = absorb.pending > 0 && sweepStatus.running
  const sweepText = filingOnly ? t('topbar.filing') : absorbing ? '' : sweepLabel(t, sweepStatus) + (sweepStatus.running ? jobSuffix : '')
  const errandPhaseKey: Record<string, StringKey> = {
    plan: 'topbar.errandPlan',
    gather: 'topbar.errandGather',
    web: 'topbar.errandWeb',
    distill: 'topbar.errandDistill',
    compose: 'topbar.errandCompose',
  }
  const errandKey = errand.phase ? errandPhaseKey[errand.phase] : undefined
  const errandText = errand.running && errandKey ? t('topbar.errand', { phase: t(errandKey) }) : ''
  const absorbText = absorb.pending > 0
    ? (engines.length === 0
        ? t('absorb.waitingEngine', { n: absorb.pending })
        : t('topbar.absorbing', { done: absorb.total - absorb.pending, total: absorb.total })) +
      (sweepStatus.running ? jobSuffix : '')
    : ''
  const activityText = errandText || sweepText || absorbText
  const working = errand.running || sweepStatus.running || filingOnly || retrying
  const ready = engines.some(engine => connectionConfirmed(engine) && engine.healthy !== false)
  const idleLabel = !enginesDetected ? 'Checking AI…' : ready ? 'Filing ready' : 'Filing AI unavailable'
  const paused = sweepStatus.kind === 'error' || sweepStatus.kind === 'done' && (!!sweepStatus.haltReason || sweepStatus.deferred > 0)

  return (
    <div className="sidebar-status-block">
        <div className={`sidebar-status-row sidebar-work-status${working ? ' working' : ''}`} data-testid="sweep-status" role="status" title={activityText}>
          <span className="sidebar-status-icon">{working || !enginesDetected ? <LoaderCircle size={14} strokeWidth={1.8} aria-hidden /> : paused || !ready ? <CircleAlert size={14} aria-hidden /> : <Check size={14} strokeWidth={2} aria-hidden />}</span>
          <span>{activityText || idleLabel}</span>
        </div>
      <button className="sidebar-filing-retry" data-testid="filing-retry" aria-label="Retry filing" title="Retry filing with the selected filing AI" disabled={!vaultReady || working} onClick={() => void retry()}><RotateCw size={14} className={retrying ? 'computer-spinner' : undefined} aria-hidden /></button>
    </div>
  )
}
