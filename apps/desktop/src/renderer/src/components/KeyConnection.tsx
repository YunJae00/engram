import { KeyRound, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BrainConnectionDto, BrainConnectionProvider } from '../../../shared/types.js'
import { api } from '../api.js'
import { t, type StringKey } from '../i18n.js'
import { SettingsItem } from './SettingsLayout.js'

// A brain reached with a key instead of a sign-in: the address that speaks the
// runtime's API, the key it issued, and the model to ask for. The key is shown
// once, on entry; afterwards only its last letters come back.
const label = (provider: BrainConnectionProvider): string => provider === 'claude' ? 'Claude' : provider === 'codex' ? 'ChatGPT' : t('settingsUi.decisionModel')
const HINT: Record<BrainConnectionProvider, StringKey> = {
  claude: 'settingsUi.hintClaude',
  codex: 'settingsUi.hintCodex',
  decision: 'settingsUi.hintDecision',
}

// One line under the row when no key is set: what a key is for here.
const SHORT: Record<BrainConnectionProvider, StringKey> = {
  claude: 'settingsUi.shortKey',
  codex: 'settingsUi.shortKey',
  decision: 'settingsUi.shortDecision',
}

export function KeyConnection({ provider, onChanged }: { provider: BrainConnectionProvider; onChanged?: () => void }) {
  const [current, setCurrent] = useState<BrainConnectionDto | null | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const [baseUrl, setBaseUrl] = useState(''), [key, setKey] = useState(''), [model, setModel] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void api.brainConnectionGet(provider).then((value) => { if (alive) { setCurrent(value); if (value) { setBaseUrl(value.baseUrl); setModel(value.model) } } }).catch(() => { if (alive) setCurrent(null) })
    return () => { alive = false }
  }, [provider])
  const save = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const next = await api.brainConnectionSet(provider, { baseUrl, key, model })
      setCurrent(next); setKey(''); setOpen(false); onChanged?.()
    } catch (cause) { setError(cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': Error: /, '') : String(cause)) }
    finally { setBusy(false) }
  }
  const remove = async () => {
    if (busy) return
    setBusy(true); setError('')
    try { await api.brainConnectionClear(provider); setCurrent(null); setBaseUrl(''); setModel(''); setKey(''); onChanged?.() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  if (current === undefined) return null
  const summary = current ? `${current.usable ? t('settingsUi.keySaved') : t('settingsUi.keyUnavailable')} · ${current.baseUrl}${current.model ? ` · ${current.model}` : ''}${current.keyHint ? ` · ${t('settingsUi.keyHint', { hint: current.keyHint })}` : ''}` : t(SHORT[provider])
  return <div className="key-connection" data-saved={!!current}><SettingsItem testId={`key-connection-${provider}`} icon={<KeyRound size={18} />} title={provider === 'decision' ? t('settingsUi.decisionModel') : t('settingsUi.apiKey')} description={open ? undefined : summary}
    below={open && <form className="key-connection-form" onSubmit={(event) => { event.preventDefault(); void save() }} aria-label={t('settingsUi.providerApiKey', { name: label(provider) })}>
      <p className="setting-hint">{t(HINT[provider])}</p>
      {provider !== 'decision' && <p className="setting-hint">{t('settingsUi.keyAccountOnly')}</p>}
      <p className="setting-hint">{t('settingsUi.creditsNote')} {provider === 'decision' ? t('settingsUi.decisionSent') : t('settingsUi.convSent')}</p>
      <label>{t('settingsUi.address')}<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} data-testid={`key-connection-${provider}-url`} /></label>
      <label>{t('settingsUi.apiKey')}<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={current ? t('settingsUi.enterKeyAgain') : t('settingsUi.pasteKey')} autoComplete="off" data-testid={`key-connection-${provider}-key`} /></label>
      <label>{t('settingsUi.model')}<input value={model} onChange={(event) => setModel(event.target.value)} placeholder={t('settingsUi.modelId')} required autoComplete="off" spellCheck={false} data-testid={`key-connection-${provider}-model`} /></label>
      <div className="engine-actions">
        <button type="submit" disabled={busy} data-testid={`key-connection-${provider}-save`}>{busy ? <><LoaderCircle size={13} className="spin" aria-hidden /> {t('settingsUi.checking')}</> : t('model.connect')}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setOpen(false); setError(''); setKey('') }}>{t('settingsUi.cancel')}</button>
      </div>
      {error && <p role="alert" className="engine-message">{error}</p>}
    </form>}>
    {!open && (current ? <>
      <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(true)}>{t('settingsUi.change')}</button>
      <button type="button" className="secondary" data-testid={`key-connection-${provider}-remove`} disabled={busy} onClick={() => void remove()}>{t('settingsUi.remove')}</button>
    </> : <button type="button" className="secondary" data-testid={`key-connection-${provider}-open`} onClick={() => setOpen(true)}>{t('settingsUi.useApiKey')}</button>)}
  </SettingsItem></div>
}
