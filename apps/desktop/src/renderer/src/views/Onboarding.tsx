import { Check, ExternalLink, Folder, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { EngineLoginDto, EngineStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { ProviderIcon } from '../components/ProviderIcon.js'
import { InstallClaude } from '../components/InstallClaude.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'

export function Onboarding() {
  const profiles = useAccountProfiles()
  const [step, setStep] = useState(1)
  const [root, setRoot] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [brains, setBrains] = useState<EngineStatusDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [connecting, setConnecting] = useState<'claude' | 'codex' | null>(null)
  const [installing, setInstalling] = useState(false)
  const [logins, setLogins] = useState<EngineLoginDto[]>([])
  const revision = useRef(0)
  const signing = useRef(false)
  const completing = useRef(false)
  const ready = brains.filter(brain => brain.installed && brain.loggedIn)

  const loadBrains = async () => {
    const at = ++revision.current
    setLoading(true)
    try { const states = await api.engineStates(); if (at === revision.current) setBrains(states) }
    catch { if (at === revision.current) setError('Could not check AI connections. Retry, or continue without AI.') }
    finally { if (at === revision.current) setLoading(false) }
  }
  useEffect(() => {
    void api.onboardDefaults().then(value => setRoot(held => held || value.defaultRoot)).catch(() => setError('Could not find your default folder. Choose a folder below.'))
    void loadBrains()
    void api.engineLogins().then(setLogins).catch(() => undefined)
    return api.onEvent(event => {
      if (event.type === 'engines:changed' || event.type === 'engines:detected') void loadBrains()
      if (event.type === 'engines:login') setLogins(held => [...held.filter(login => login.id !== event.login.id || login.profile !== event.login.profile), event.login])
    })
  }, [])

  const connect = async (id: 'claude' | 'codex') => {
    if (signing.current) return
    signing.current = true; setConnecting(id); setError('')
    try {
      const result = await api.engineConnect(id)
      if (!result.ok) setError(result.message || 'Sign-in was cancelled. You can try again or continue without AI.')
      else {
        const settings = await api.settingsGet()
        await api.settingsSet({ ...settings, defaultEngine: id })
        await api.aiSelectionSet('filing', { engine: id, model: '' })
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in did not finish. Please try again.') }
    finally { signing.current = false; setConnecting(null); await loadBrains() }
  }
  const finish = async () => {
    if (completing.current || signing.current || installing || !root.trim()) return
    completing.current = true; setFinishing(true); setError('')
    try {
      const settings = await api.settingsGet()
      const available = ready.find(brain => brain.id === settings.defaultEngine) ?? ready[0]
      if (available && (available.id === 'claude' || available.id === 'codex')) {
        if (settings.defaultEngine !== available.id) await api.settingsSet({ ...settings, defaultEngine: available.id })
        const filingEngine = settings.aiSelections?.filing?.engine ?? settings.defaultEngine
        if (!ready.some(brain => brain.id === filingEngine)) await api.aiSelectionSet('filing', { engine: available.id, model: '' })
      }
      await api.onboardComplete({ root: root.trim(), importFolder: null, teamUrl: null, firstCapture: null })
    }
    catch (cause) { completing.current = false; setFinishing(false); setError(cause instanceof Error ? cause.message : 'Could not create your workspace. Please try again.') }
  }
  const loginAction = (action: Promise<unknown>) => void action.catch(() => setError('Could not update the sign-in window. Please try again.'))

  return <div className="onboarding" data-testid="onboarding"><div className="onboard-card">
    <div className="onboard-progress" aria-label={`Step ${step} of 2`}><strong>Engram</strong><span>{step} / 2</span></div>
    {step === 1 ? <section data-testid="onboard-step-1">
      <h1>Your space to think and do.</h1>
      <p className="onboard-sub">Browse, chat, and keep your work in one place. Your workspace is a folder on this computer.</p>
      <label className="onboard-folder-label" htmlFor="onboard-root"><Folder size={16} aria-hidden />Workspace folder</label>
      <input id="onboard-root" data-testid="vault-root-input" value={root} placeholder="Choose a workspace folder" onChange={event => setRoot(event.target.value)} />
      <button className="onboard-choose-folder" onClick={() => void api.importPick().then(value => { if (value) setRoot(value) }).catch(() => setError('Could not open the folder picker.'))}>Choose a different folder…</button>
      <p className="onboard-note">The suggested location is ready to use. You can connect your AI next, or start browsing without one.</p>
      <p className="onboard-note">The local activity journal records app names and window titles, not screen contents. You can turn it off in Settings.</p>
      <div className="onboard-actions"><button className="primary" data-testid="onboard-next" disabled={!root.trim()} onClick={() => { setError(''); setStep(2) }}>Continue</button></div>
    </section> : <section data-testid="onboard-step-2">
      <h1>Connect your AI.</h1>
      <p className="onboard-sub">Connect either account, or both. Sign in securely in your browser; no API key or terminal setup needed.</p>
      <div className="onboard-providers" aria-busy={loading}>
        {(['claude', 'codex'] as const).map(id => {
          const state = brains.find(brain => brain.id === id)
          const login = logins.find(item => item.id === id && (item.profile ?? 'system') === (profiles?.selected[id] ?? 'system'))
          const connected = state?.installed && state.loggedIn
          const active = connecting === id
          return <div className="onboard-provider" key={id}>
            <ProviderIcon provider={id} size={24} />
            <div><strong>{id === 'claude' ? 'Claude' : 'ChatGPT'}</strong><span data-testid={`onboard-brain-${id}`}>{active ? login?.phase === 'browser' ? 'Finish signing in in your browser' : 'Opening sign-in…' : connected ? 'Connected' : loading ? 'Checking connection…' : state?.installed ? 'Use your existing account' : id === 'claude' ? 'Install once, then connect your account' : 'Runtime unavailable — reinstall Engram to repair'}</span></div>
            {active || loading ? <LoaderCircle size={18} className="computer-spinner" aria-label={active ? 'Signing in' : 'Checking connection'} /> : connected ? <Check size={18} aria-label="Connected" /> : id === 'claude' && state && !state.installed ? <InstallClaude onInstalled={() => void loadBrains()} onBusy={setInstalling} /> : <button className="secondary" data-testid={`onboard-connect-${id}`} disabled={!!connecting || !state?.installed || finishing || installing} onClick={() => void connect(id)}>Connect</button>}
            {active && <div className="onboard-login-actions">{login?.canOpen && <button className="secondary" onClick={() => loginAction(api.engineOpenLogin(id))}><ExternalLink size={13} aria-hidden />Open browser</button>}<button className="secondary" onClick={() => loginAction(api.engineCancelLogin(id))}>Cancel sign-in</button></div>}
          </div>
        })}
      </div>
      <p className="onboard-note">Choose separate models for conversations and filing later. Only the context needed for an AI request is sent to its provider.</p>
      <div className="onboard-actions"><button className="secondary" disabled={finishing || !!connecting || installing} onClick={() => setStep(1)}>Back</button><button className={ready.length ? 'primary' : 'secondary'} data-testid={ready.length ? 'onboard-finish' : 'onboard-skip-ai'} disabled={finishing || !!connecting || installing} onClick={() => void finish()}>{finishing ? <><LoaderCircle size={14} className="computer-spinner" aria-hidden />Creating workspace…</> : ready.length ? 'Start using Engram' : 'Continue without AI'}</button></div>
    </section>}
    {error && <div className="onboard-fail" role="alert">{error}{step === 2 && <button className="secondary" data-testid="onboard-brains-retry" disabled={loading || !!connecting} onClick={() => { setError(''); void loadBrains() }}>Check connections again</button>}</div>}
  </div></div>
}
