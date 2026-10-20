import { useState } from 'react'
import { LoaderCircle, RotateCcw } from 'lucide-react'
import { api, apiErrorText } from '../api.js'
import { SettingsItem } from './SettingsLayout.js'

export function ResetSettings() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reset = async () => {
    setBusy(true); setError('')
    try { if (!await api.resetApp()) setBusy(false) }
    catch (cause) { setError(apiErrorText(cause instanceof Error ? cause.message : String(cause))); setBusy(false) }
  }
  return <SettingsItem icon={<RotateCcw size={18} />} title="Start fresh" description="Erase Engram's local data and set it up again. AI sign-ins stay."
    below={error && <p role="alert" className="settings-save-status">{error}</p>}>
    <button type="button" className="secondary" data-testid="settings-reset" disabled={busy} onClick={() => void reset()}>{busy ? <><LoaderCircle size={14} className="spin" aria-hidden />Restarting…</> : 'Reset…'}</button>
  </SettingsItem>
}
