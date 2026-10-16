import { KeyRound, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { BrainConnectionDto, BrainConnectionProvider } from '../../../shared/types.js'
import { api } from '../api.js'

// A brain reached with a key instead of a sign-in: the address that speaks the
// runtime's API, the key it issued, and the model to ask for. The key is shown
// once, on entry; afterwards only its last letters come back.
const LABEL: Record<BrainConnectionProvider, string> = { claude: 'Claude', codex: 'ChatGPT', decision: 'Decision model' }
const HINT: Record<BrainConnectionProvider, string> = {
  claude: 'An address that speaks the Anthropic Messages API, such as a company gateway.',
  codex: 'An address that speaks the OpenAI Responses API, such as a company gateway.',
  decision: 'The decisions endpoint of a gateway or of the model vendor; used to pick the next step in an app quickly.',
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
  return <div className="key-connection" data-testid={`key-connection-${provider}`}>
    {current && !open ? <p className="key-connection-summary">
      <KeyRound size={13} aria-hidden /> {current.usable ? 'API key saved · model tested when saved' : 'Key unavailable · reconnect'} · {current.baseUrl}{current.model ? ` · ${current.model}` : ''}{current.keyHint ? ` · key ${current.keyHint}` : ''}
      <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(true)}>Change</button>
      <button type="button" className="secondary" data-testid={`key-connection-${provider}-remove`} disabled={busy} onClick={() => void remove()}>Remove</button>
    </p> : !open ? <button type="button" className="secondary" data-testid={`key-connection-${provider}-open`} onClick={() => setOpen(true)}><KeyRound size={13} aria-hidden /> Use an API key instead</button>
    : <form className="key-connection-form" onSubmit={(event) => { event.preventDefault(); void save() }} aria-label={`${LABEL[provider]} API key`}>
      <p className="setting-hint">{HINT[provider]}</p>
      {provider !== 'decision' && <p className="setting-hint">This key is used only for the selected account.</p>}
      <p className="setting-hint">A short model test may use API credits. {provider === 'decision' ? 'App controls, visible text and your goal are sent to this address during app actions.' : 'Conversation content is sent to this address when you use this connection.'}</p>
      <label>Address<input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://…" autoComplete="off" spellCheck={false} data-testid={`key-connection-${provider}-url`} /></label>
      <label>API key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} placeholder={current ? 'Enter the key again to change it' : 'Paste the key'} autoComplete="off" data-testid={`key-connection-${provider}-key`} /></label>
      <label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Model ID" required autoComplete="off" spellCheck={false} data-testid={`key-connection-${provider}-model`} /></label>
      <div className="engine-actions">
        <button type="submit" disabled={busy} data-testid={`key-connection-${provider}-save`}>{busy ? <><LoaderCircle size={13} className="spin" aria-hidden /> Checking…</> : 'Connect'}</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setOpen(false); setError(''); setKey('') }}>Cancel</button>
      </div>
      {error && <p role="alert" className="engine-message">{error}</p>}
    </form>}
  </div>
}
