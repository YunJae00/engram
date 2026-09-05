import { Check, LoaderCircle } from 'lucide-react'
import type { SweepStatus } from '../state.js'
import { t, type StringKey, type Translate } from '../i18n.js'
import { useTopBarState } from '../state-slices.js'

function sweepLabel(translate: Translate, status: SweepStatus): string {
  switch (status.kind) {
    case 'running':
      return translate('topbar.sweepRunning')
    case 'done':
      if (status.haltReason === 'quota') return translate('topbar.sweepQuota', { n: status.deferred })
      if (status.haltReason === 'auth') return translate('topbar.sweepAuth', { n: status.deferred })
      if (status.deferred > 0) return translate('topbar.sweepDeferred', { n: status.deferred })
      return translate('topbar.sweepDone', { executed: status.executed, skipped: status.skipped })
    case 'error':
      return status.message
    default:
      return ''
  }
}

export function SidebarStatus() {
  const { engines, sweepStatus, filing, absorb, sweepJob, errand } = useTopBarState()
  const engine = engines[0]
  const engineName = engine?.id === 'codex' ? t('settings.brainChatGPT') : engine?.id === 'claude' ? t('settings.brainClaude') : engine?.id
  const engineLabel = !engine
    ? t('topbar.engineConnectShort')
    : engine.healthy === false
      ? t('sidebar.aiAttention', { name: engineName ?? engine.id })
      : t('sidebar.aiConnected', { name: engineName ?? engine.id })

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
  const working = errand.running || sweepStatus.running || filingOnly || absorb.pending > 0

  return (
    <div className="sidebar-status-block">
      <button
        className="sidebar-status-row sidebar-engine-status"
        data-testid="engine-status"
        title={engineLabel}
        onClick={() => window.dispatchEvent(new Event('engram:open-diagnostics'))}
      >
        <span className={`engine-dot${!engine ? '' : engine.healthy === false ? ' warn' : ' on'}`} />
        <span>{engineLabel}</span>
      </button>
      {activityText && (
        <div className={`sidebar-status-row sidebar-work-status${working ? ' working' : ''}`} data-testid="sweep-status" role="status" title={activityText}>
          {working ? <LoaderCircle size={12} strokeWidth={1.8} aria-hidden /> : <Check size={12} strokeWidth={2} aria-hidden />}
          <span>{activityText}</span>
        </div>
      )}
    </div>
  )
}
