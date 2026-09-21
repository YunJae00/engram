import type { SemanticStatusDto, UpdateCheckDto } from '../../../shared/types.js'
import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
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
  const [installing, setInstalling] = useState(false)
  const checkForUpdate = () => {
    if (checkingUpdate) return
    onCheckingUpdate(true)
    void api
      .updateCheck()
      .then(onUpdate)
      .catch(() => onUpdate({ state: 'error', message: 'Could not check for updates. Try again.', selfInstalls: false }))
      .finally(() => onCheckingUpdate(false))
  }

  return (
    <div className="settings-facts">
      <div className="settings-fact" title={t('settings.semanticHint')}>
        <span className="settings-fact-key">{t('settings.semanticTitle')}</span>
        <span className="settings-fact-value" data-testid="semantic-status" role="status" aria-busy={!semantic || ['loading', 'indexing'].includes(semantic.status)}>
          {(!semantic || ['loading', 'indexing'].includes(semantic.status)) && <LoaderCircle size={14} className="spin" aria-hidden />}
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
            semantic ? t('settings.semanticIdle') : 'Checking…'
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
        <span className="settings-fact-value" data-testid="settings-update" aria-busy={checkingUpdate || installing || update?.state === 'downloading'}>
          {update?.state === 'downloading' ? (
            <>
              {t('settings.updateDownloading', {
                version: update.version ?? '',
                percent: update.percent ?? 0,
              })}
              <progress max={100} value={update.percent} aria-label="Update download" />
            </>
          ) : update?.state === 'ready' || update?.state === 'available' ? (
            <>
              {t('settings.updateAvailable', { version: update.version ?? '' })}
              <button
                className="secondary settings-fact-btn"
                disabled={installing}
                onClick={() => {
                  setInstalling(true)
                  void api.updateInstall().then((result) => {
                    if (!result.started) return api.updateCheck().then(onUpdate)
                  }).catch(() => onUpdate({ state: 'error', message: 'Could not open the update. Try again.', selfInstalls: false })).finally(() => setInstalling(false))
                }}
              >
                {installing ? <><LoaderCircle size={14} className="spin" aria-hidden />Opening…</> : update.selfInstalls ? t('banner.updateRestart') : t('settings.updateGet')}
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
                {checkingUpdate && <LoaderCircle size={14} className="spin" aria-hidden />}{t('settings.updateCheck')}
              </button>
            </>
          )}
        </span>
      </div>
    </div>
  )
}
