import { Monitor, Square, X } from 'lucide-react'
import { useState } from 'react'
import { desktopError, stopComputerControl, useDesktopSession } from '../lib/desktopSession.js'
import { computerStateLabel } from './ComputerStatus.js'
import { SettingsItem, SettingsGroup } from './SettingsLayout.js'

// Apps are always within reach; there is nothing to switch on. What is shown
// is whether a comet holds the mouse right now, and the way to take it back.
export function ComputerSettings() {
  const { available, control } = useDesktopSession()
  const [error, setError] = useState('')
  const active = control && control.state !== 'idle'
  const dismiss = control?.state === 'paused' && !control.resumable
  const value = available === null ? 'Checking…' : available === false ? 'Unavailable on this build' : active && control ? computerStateLabel(control) : 'Ready'
  return <div className="computer-settings" data-testid="computer-settings">
    <SettingsGroup title="Computer use">
      <SettingsItem icon={<Monitor size={18} />} title="Apps on this computer" description="Engram uses your mouse and keyboard when a task needs an app. Move the mouse to pause, press Esc to stop. Passwords and sign-in pages stay off limits."
        below={(active || error) && <>
          {active && <button className="computer-stop" onClick={() => { setError(''); void stopComputerControl().catch((cause: unknown) => setError(desktopError(cause))) }}>{dismiss ? <X size={12} aria-hidden /> : <Square size={10} fill="currentColor" aria-hidden />}{dismiss ? 'Dismiss' : 'Stop computer control'}</button>}
          {error && <p className="computer-error" role="alert">{error}</p>}
        </>}>
        <span className="settings-item-state" role="status" data-testid="computer-use-state">{value}</span>
      </SettingsItem>
    </SettingsGroup>
  </div>
}
