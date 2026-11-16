import { Monitor, Square, X } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { cometChannel } from '../lib/cometThreads.js'
import { cometThreads } from '../lib/cometThreadsLive.js'
import { threadWords } from '../lib/threadLang.js'
import { desktopError, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'
import { t, uiLanguage } from '../i18n.js'
import { ComputerDialog } from './ComputerDialog.js'
import { computerStateLabel } from './ComputerStatus.js'
import { SettingsItem, SettingsGroup } from './SettingsLayout.js'

// Apps are always within reach; there is nothing to switch on. What is shown
// is whether a comet holds the mouse right now, and the way to take it back.
// Session control is per conversation, so the window picker opens for the
// conversation that is open behind Settings.
export function ComputerSettings() {
  const { available, control } = useDesktopSession()
  const [error, setError] = useState('')
  const botId = useSyncExternalStore(cometThreads.subscribe, () => cometThreads.getSnapshot().selectedId)
  const [dialogOpen, setDialogOpen] = useState(false)
  const lang = uiLanguage()
  const controls = available === true && botId
  const active = control && control.state !== 'idle'
  const dismiss = control?.state === 'paused' && !control.resumable
  const value = available === null ? t('settingsUi.checking') : available === false ? t('settingsUi.unavailableBuild') : active && control ? computerStateLabel(control) : t('settingsUi.ready')
  // Esc closes the dialog only; without this the same key would also close Settings underneath.
  return <div className="computer-settings" data-testid="computer-settings" onKeyDown={dialogOpen ? event => { if (event.key === 'Escape') event.stopPropagation() } : undefined}>
    <SettingsGroup title={t('settingsUi.computerUse')}>
      <SettingsItem icon={<Monitor size={18} />} title={t('settingsUi.computerApps')} description={t('settingsUi.computerHint')}
        below={(active || error) && <>
          {active && <button className="computer-stop" onClick={() => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }}>{dismiss ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}{dismiss ? t('settingsUi.dismiss') : t('settingsUi.stopControl')}</button>}
          {error && <p className="computer-error" role="alert">{error}</p>}
        </>}>
        <span className="settings-item-state" role="status" data-testid="computer-use-state">{value}</span>
        {controls && <button className="computer-secondary" data-testid="computer-controls-open" onClick={() => setDialogOpen(true)}>{threadWords(lang).computerControls}</button>}
      </SettingsItem>
      {dialogOpen && botId && <ComputerDialog lane={cometChannel(botId)} lang={lang} onClose={() => setDialogOpen(false)} />}
    </SettingsGroup>
  </div>
}
