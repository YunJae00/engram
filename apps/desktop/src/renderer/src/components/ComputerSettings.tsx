import { Monitor, Square, X } from 'lucide-react'
import { useState } from 'react'
import { desktopError, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'
import { t } from '../i18n.js'
import { computerStateLabel } from './ComputerStatus.js'
import { SettingsItem, SettingsGroup } from './SettingsLayout.js'

// Apps are always within reach; there is nothing to switch on. What is shown
// is whether a comet holds the mouse right now, and the way to take it back.
export function ComputerSettings() {
  const { available, control } = useDesktopSession()
  const [error, setError] = useState('')
  const active = control && control.state !== 'idle'
  const dismiss = control?.state === 'paused' && !control.resumable
  const value = available === null ? t('settingsUi.checking') : available === false ? t('settingsUi.unavailableBuild') : active && control ? computerStateLabel(control) : t('settingsUi.ready')
  return <div className="computer-settings" data-testid="computer-settings">
    <SettingsGroup title={t('settingsUi.computerUse')}>
      <SettingsItem icon={<Monitor size={18} />} title={t('settingsUi.computerApps')} description={t('settingsUi.computerHint')}
        below={(active || error) && <>
          {active && <button className="computer-stop" onClick={() => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }}>{dismiss ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}{dismiss ? t('settingsUi.dismiss') : t('settingsUi.stopControl')}</button>}
          {error && <p className="computer-error" role="alert">{error}</p>}
        </>}>
        <span className="settings-item-state" role="status" data-testid="computer-use-state">{value}</span>
      </SettingsItem>
    </SettingsGroup>
  </div>
}
