import { Download, PlugZap } from 'lucide-react'
import { memo } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'
import type { AppState } from '../state.js'

interface AppNoticesProps {
  engines: AppState['engines']
  enginesDetected: boolean
  pendingWork: AppState['pendingWork']
  updateReady: string | null
  updateSelfInstalls: boolean
  vaultReady: boolean
  onOpenSettings: () => void
}

export const AppNotices = memo(function AppNotices({
  engines,
  enginesDetected,
  pendingWork,
  updateReady,
  updateSelfInstalls,
  vaultReady,
  onOpenSettings,
}: AppNoticesProps) {
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
      {vaultReady && enginesDetected && engines.length === 0 && (
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
      {unhealthy.length > 0 && (
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
      {updateReady && (
        <div className="connect-banner update-banner" data-testid="update-banner">
          <Download size={14} strokeWidth={1.8} aria-hidden />
          <span>
            {updateSelfInstalls
              ? t('banner.updateReady', { version: updateReady })
              : t('banner.updateAvailable', { version: updateReady })}
          </span>
          <button className="connect-banner-btn" onClick={() => void api.updateInstall()}>
            {updateSelfInstalls ? t('banner.updateRestart') : t('banner.updateDownload')}
          </button>
        </div>
      )}
    </div>
  )
})
