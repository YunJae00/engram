import type { SemanticStatusDto, UpdateCheckDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'

interface SettingsStatusProps {
  checkingUpdate: boolean
  semantic: SemanticStatusDto | null
  update: UpdateCheckDto | null
  version: string | null
  onCheckingUpdate: (checking: boolean) => void
  onUpdate: (update: UpdateCheckDto) => void
}

export function SettingsStatus({
  checkingUpdate,
  semantic,
  update,
  version,
  onCheckingUpdate,
  onUpdate,
}: SettingsStatusProps) {
  const checkForUpdate = () => {
    onCheckingUpdate(true)
    void api
      .updateCheck()
      .then(onUpdate)
      .catch(() => {})
      .finally(() => onCheckingUpdate(false))
  }

  return (
    <div className="settings-facts">
      <div className="settings-fact" title={t('settings.semanticHint')}>
        <span className="settings-fact-key">{t('settings.semanticTitle')}</span>
        <span className="settings-fact-value" data-testid="semantic-status">
          {semantic && semantic.status !== 'off' ? (
            <>
              {
                {
                  loading: t('settings.semanticLoading'),
                  indexing: t('settings.semanticIndexing'),
                  ready: t('settings.semanticReady'),
                  error: t('settings.semanticError'),
                }[semantic.status]
              }
              {semantic.detail ? ` — ${semantic.detail}` : ''}
              <span className="settings-fact-sub">{semantic.model}</span>
            </>
          ) : (
            t('settings.semanticIdle')
          )}
        </span>
      </div>
      <div className="settings-fact">
        <span className="settings-fact-key">{t('settings.versionKey')}</span>
        <span className="settings-fact-value" data-testid="settings-version">
          {version ?? '—'}
        </span>
      </div>
      <div className="settings-fact">
        <span className="settings-fact-key">{t('settings.updateKey')}</span>
        <span className="settings-fact-value" data-testid="settings-update">
          {update?.state === 'downloading' ? (
            <>
              {t('settings.updateDownloading', {
                version: update.version ?? '',
                percent: update.percent ?? 0,
              })}
              <button
                className="secondary settings-fact-btn"
                data-testid="settings-update-refresh"
                disabled={checkingUpdate}
                onClick={checkForUpdate}
              >
                {t('settings.updateCheck')}
              </button>
            </>
          ) : update?.state === 'ready' || update?.state === 'available' ? (
            <>
              {t('settings.updateAvailable', { version: update.version ?? '' })}
              <button
                className="secondary settings-fact-btn"
                onClick={() => {
                  void api.updateInstall().then((result) => {
                    if (!result.started) void api.updateCheck().then(onUpdate)
                  })
                }}
              >
                {update.selfInstalls ? t('banner.updateRestart') : t('settings.updateGet')}
              </button>
            </>
          ) : (
            <>
              {checkingUpdate
                ? t('settings.updateChecking')
                : update?.state === 'current'
                  ? t('settings.updateCurrent')
                  : update?.state === 'error'
                    ? t('settings.updateError', { reason: update.message ?? '' })
                    : update?.state === 'checking-unavailable'
                      ? t('settings.updateDev')
                      : ''}
              <button
                className="secondary settings-fact-btn"
                data-testid="settings-update-check"
                disabled={checkingUpdate}
                onClick={checkForUpdate}
              >
                {t('settings.updateCheck')}
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  )
}
