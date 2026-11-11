import { LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../api.js'
import { t } from '../i18n.js'

export function InstallClaude({ onInstalled, onBusy }: { onInstalled(): void; onBusy?(busy: boolean): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const install = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); onBusy?.(true); setError('')
    try { await api.installClaude(); onInstalled() }
    catch (cause) { setError(cause instanceof Error ? cause.message : t('settingsUi.installFailed')) }
    finally { pending.current = false; setBusy(false); onBusy?.(false) }
  }
  return <div className="claude-install">
    <button className="secondary" disabled={busy} onClick={() => void install()}>{busy && <LoaderCircle size={14} className="computer-spinner" aria-hidden />}{busy ? t('settingsUi.downloadingVerifying') : t('settingsUi.installRuntime')}</button>
    <p className="setting-note">{t('settingsUi.runtimeTerms')}</p>
    {error && <p role="alert">{error} <button className="secondary" onClick={() => void api.claudeInstallHelp().catch(() => setError(t('settingsUi.guideFailed')))}>{t('settingsUi.installGuide')}</button></p>}
  </div>
}
