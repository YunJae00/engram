import { LoaderCircle } from 'lucide-react'
import { useRef, useState } from 'react'
import { api } from '../api.js'

export function InstallClaude({ onInstalled, onBusy }: { onInstalled(): void; onBusy?(busy: boolean): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const install = async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); onBusy?.(true); setError('')
    try { await api.installClaude(); onInstalled() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not install Claude. Try again or open the official installation guide.') }
    finally { pending.current = false; setBusy(false); onBusy?.(false) }
  }
  return <div className="claude-install">
    <button className="secondary" disabled={busy} onClick={() => void install()}>{busy && <LoaderCircle size={14} className="computer-spinner" aria-hidden />}{busy ? 'Downloading and verifying…' : 'Install Claude runtime'}</button>
    <p className="setting-note">Downloads the official runtime separately. Anthropic’s terms apply. You sign in directly with your own account after installation.</p>
    {error && <p role="alert">{error} <button className="secondary" onClick={() => void api.claudeInstallHelp().catch(() => setError('Could not open the guide. Visit code.claude.com/docs/en/setup in your browser.'))}>Official installation guide</button></p>}
  </div>
}
