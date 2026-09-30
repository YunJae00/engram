import { Download, LoaderCircle, PlugZap } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import type { UpdateCheckDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import type { AppState } from '../state.js'

interface AppNoticesProps {
  showAiNotices?: boolean
  engines: AppState['engines']
  enginesDetected: boolean
  pendingWork: AppState['pendingWork']
  update: UpdateCheckDto | null
  vaultReady: boolean
  onOpenSettings: () => void
}

export const AppNotices = memo(function AppNotices({
  showAiNotices = true,
  engines,
  enginesDetected,
  pendingWork,
  update,
  vaultReady,
  onOpenSettings,
}: AppNoticesProps) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => setError(false), [update?.version, update?.state])
  const unhealthy = engines.filter((engine) => engine.healthy === false)
  const unhealthyIds = unhealthy.map((engine) => engine.id).join(', ')
  const reason = unhealthy[0]?.healthReason
  const unhealthyText =
    reason === 'auth'
      ? t('banner.loginExpired', { ids: unhealthyIds })
      : reason === 'quota'
        ? t('banner.quota', { ids: unhealthyIds })
        : reason === 'network'
          ? t('banner.offline', { ids: unhealthyIds })
          : t('banner.notResponding', { ids: unhealthyIds })
  const waiting = pendingWork.inbox + pendingWork.notes

  return (
    <div className="notices">
      {showAiNotices && vaultReady && enginesDetected && engines.length === 0 && (
        <div className="connect-banner" data-testid="connect-banner">
          <PlugZap size={14} strokeWidth={1.8} aria-hidden />
          <span>
            {t('banner.noBrain')}
            {waiting > 0 && ` · ${t('banner.waiting', { n: waiting })}`}
          </span>
          <button className="connect-banner-btn" onClick={onOpenSettings}>
            {t('banner.getBrain')}
          </button>
        </div>
      )}
      {showAiNotices && unhealthy.length > 0 && (
        <div className="connect-banner" data-testid="unhealthy-banner">
          <PlugZap size={14} strokeWidth={1.8} aria-hidden />
          <span>{unhealthyText}</span>
          <button
            className="connect-banner-btn"
            onClick={() => window.dispatchEvent(new Event('engram:open-diagnostics'))}
          >
            {reason === 'auth' ? t('banner.login') : t('banner.check')}
          </button>
        </div>
      )}
      {update?.version && !['current', 'checking-unavailable'].includes(update.state) && (
        <div className="connect-banner update-banner" data-testid="update-banner">
          <Download size={14} strokeWidth={1.8} aria-hidden />
          <span>
            {error ? t('settings.updateError', { reason: 'Could not check for updates. Try again.' })
              : update.state === 'downloading' ? t('settings.updateDownloading', { version: update.version, percent: update.percent ?? 0 })
              : update.state === 'error' ? t('settings.updateError', { reason: update.message ?? '' })
              : update.state === 'ready' ? t('banner.updateReady', { version: update.version })
              : t('banner.updateAvailable', { version: update.version })}
          </span>
          <button className="connect-banner-btn" disabled={checking || update.state === 'downloading'} onClick={() => {
            setChecking(true); setError(false)
            void (update.state === 'error' ? api.updateCheck().then(result => { setError(result.state === 'error') })
              : api.updateInstall().then(result => { setError(!result.started && result.reason !== 'downloading') }))
              .catch(() => setError(true)).finally(() => setChecking(false))
          }}>
            {checking || update.state === 'downloading' ? <LoaderCircle size={14} className="spin" aria-label="Checking update" />
              : update.state === 'error' || error ? t('settings.updateCheck')
              : update.selfInstalls ? t('banner.updateRestart') : t('banner.updateDownload')}
          </button>
        </div>
      )}
    </div>
  )
})
