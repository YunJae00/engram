import type { UpdateCheckDto } from '../../../shared/types.js'
import { useState } from 'react'
import { Download, Info, LoaderCircle } from 'lucide-react'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { SettingsItem } from './SettingsLayout.js'

interface SettingsStatusProps {
  checkingUpdate: boolean
  update: UpdateCheckDto | null
  version: string | null
  onCheckingUpdate: (checking: boolean) => void
  onUpdate: (update: UpdateCheckDto) => void
}

export function SettingsStatus({ checkingUpdate, update, version, onCheckingUpdate, onUpdate }: SettingsStatusProps) {
  const [installing, setInstalling] = useState(false)
  const checkForUpdate = () => {
    if (checkingUpdate) return
    onCheckingUpdate(true)
    void api
      .updateCheck()
      .then(onUpdate)
      .catch(() => onUpdate({ state: 'error', message: t('settingsUi.updateCheckFailed'), selfInstalls: false }))
      .finally(() => onCheckingUpdate(false))
  }
  const install = () => {
    setInstalling(true)
    void api.updateInstall().then((result) => {
      if (!result.started) return api.updateCheck().then(onUpdate)
    }).catch(() => onUpdate({ state: 'error', message: t('settingsUi.updateOpenFailed'), selfInstalls: false })).finally(() => setInstalling(false))
  }
  const downloading = update?.state === 'downloading'
  const offered = update?.state === 'ready' || update?.state === 'available'
  const percent = Math.max(0, Math.min(100, Math.round(update?.percent ?? 0)))
  const updateWords = downloading ? t('settings.updateDownloading', { version: update.version ?? '', percent })
    : offered ? t('settings.updateAvailable', { version: update.version ?? '' })
      : checkingUpdate ? t('settings.updateChecking')
        : update?.state === 'current' ? t('settings.updateCurrent')
          : update?.state === 'error' ? t('settings.updateError', { reason: update.message ?? '' })
            : update?.state === 'checking-unavailable' ? t('settings.updateDev') : ''
  return <>
    <SettingsItem icon={<Info size={18} />} title={t('settings.versionKey')}><span className="settings-item-value" data-testid="settings-version">{version ?? '—'}</span></SettingsItem>
    <div data-testid="settings-update" aria-busy={checkingUpdate || installing || downloading}><SettingsItem icon={<Download size={18} />} title={t('settings.updateKey')} description={updateWords}
      below={downloading && <progress className="update-progress" max={100} value={percent} aria-label={t('settingsUi.updateDownload')} />}>
      {offered ? <button className="secondary" disabled={installing} onClick={install}>{installing ? <><LoaderCircle size={14} className="spin" aria-hidden />{t('settingsUi.opening')}</> : update.selfInstalls ? t('banner.updateRestart') : t('settings.updateGet')}</button>
        : !downloading && <button className="secondary" data-testid="settings-update-check" disabled={checkingUpdate} onClick={checkForUpdate}>{checkingUpdate && <LoaderCircle size={14} className="spin" aria-hidden />}{t('settings.updateCheck')}</button>}
    </SettingsItem></div>
  </>
}
