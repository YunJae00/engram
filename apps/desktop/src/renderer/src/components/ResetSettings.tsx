import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { api, apiErrorText } from '../api.js'

export function ResetSettings() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reset = async () => {
    setBusy(true); setError('')
    try { if (!await api.resetApp()) setBusy(false) }
    catch (cause) { setError(apiErrorText(cause instanceof Error ? cause.message : String(cause))); setBusy(false) }
  }
  return <section aria-label="Reset Engram" className="settings-group">
    <div className="setting-row"><span className="settings-row-label"><span>Start fresh<small>Erase local Engram data and restart setup. AI sign-ins stay.</small></span></span>
      <button type="button" className="secondary" data-testid="settings-reset" disabled={busy} onClick={() => void reset()}>{busy ? <><LoaderCircle size={14} className="spin" aria-hidden />Restarting…</> : 'Reset Engram…'}</button>
    </div>
    {error && <p role="alert" className="settings-save-status">{error}</p>}
  </section>
}
