import { Check, ExternalLink, Folder, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { EngineLoginDto, EngineStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { INTERVIEW_PENDING_KEY } from '../components/WorkInterview.js'
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
  const [learnWork, setLearnWork] = useState(false)
  const [interview, setInterview] = useState(true)
  const revision = useRef(0)
  // Only the first check shows spinners; later ones refresh behind what is shown.
  const checked = useRef(false)
  const signing = useRef(false)
  const completing = useRef(false)
  const ready = brains.filter(brain => brain.installed && brain.loggedIn)

  const loadBrains = async () => {
    const at = ++revision.current
    if (!checked.current) setLoading(true)
    try { const states = await api.engineStates(); if (at === revision.current) { setBrains(states); checked.current = true } }
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
      const latest = await api.settingsGet()
      if (latest.workMap !== learnWork) await api.settingsSet({ ...latest, workMap: learnWork })
      try { if (interview && available) localStorage.setItem(INTERVIEW_PENDING_KEY, '1'); else localStorage.removeItem(INTERVIEW_PENDING_KEY) } catch { /* the interview stays in Settings */ }
      await api.onboardComplete({ root: root.trim(), importFolder: null, teamUrl: null, firstCapture: null })
    }
    catch (cause) { completing.current = false; setFinishing(false); setError(cause instanceof Error ? cause.message : 'Could not create your workspace. Please try again.') }
  }
  const loginAction = (action: Promise<unknown>) => void action.catch(() => setError('Could not update the sign-in window. Please try again.'))

  return <div className="onboarding" data-testid="onboarding"><div className="onboard-card">
    <div className="onboard-progress" aria-label={`Step ${step} of 2`}><strong>Engram</strong><span>{step} / 2</span></div>
    {step === 1 ? <section data-testid="onboard-step-1">
      <h1>Choose your workspace</h1>
      <div className="onboard-folder">
        <Folder size={18} aria-hidden />
        <input id="onboard-root" aria-label="Workspace folder" data-testid="vault-root-input" value={root} placeholder="Workspace folder" onChange={event => setRoot(event.target.value)} />
        <button className="secondary" aria-label="Choose workspace folder" onClick={() => void api.importPick().then(value => { if (value) setRoot(value) }).catch(() => setError('Could not open the folder picker.'))}>Choose…</button>
      </div>
      <p className="onboard-note">Activity journal saves app names and window titles locally, not screen contents. Turn off in Settings.</p>
      <div className="onboard-actions"><button className="primary" data-testid="onboard-next" disabled={!root.trim()} onClick={() => { setError(''); setStep(2) }}>Continue</button></div>
    </section> : <section data-testid="onboard-step-2">
      <h1>Connect your AI</h1>
      <div className="onboard-providers" aria-busy={loading}>
        {(['claude', 'codex'] as const).map(id => {
          const state = brains.find(brain => brain.id === id)
          const login = logins.find(item => item.id === id && (item.profile ?? 'system') === (profiles?.selected[id] ?? 'system'))
          const connected = (state?.installed && state.loggedIn) || login?.phase === 'connected'
          const active = connecting === id
          return <div className="onboard-provider" key={id}>
            <ProviderIcon provider={id} size={24} />
            <div className="onboard-provider-info"><strong>{id === 'claude' ? 'Claude' : 'ChatGPT'}</strong>{active && <span role="status">{login?.phase === 'browser' ? 'Finish in your browser' : 'Opening sign-in…'}</span>}{!loading && !active && id === 'codex' && state && !state.installed && <span>Reinstall Engram to connect.</span>}</div>
            {active || loading ? <LoaderCircle size={18} className="computer-spinner" aria-label={active ? 'Signing in' : 'Checking connection'} /> : connected ? <span className="onboard-connected" data-testid={`onboard-brain-${id}`} role="status"><Check size={15} aria-hidden />Connected</span> : id === 'claude' && state && !state.installed ? <InstallClaude onInstalled={() => void loadBrains()} onBusy={setInstalling} /> : <button className="secondary" data-testid={`onboard-connect-${id}`} disabled={!!connecting || !state?.installed || finishing || installing} onClick={() => void connect(id)}>Connect</button>}
            {active && <div className="onboard-login-actions">{login?.canOpen && <button className="secondary" onClick={() => loginAction(api.engineOpenLogin(id))}><ExternalLink size={13} aria-hidden />Open browser</button>}<button className="secondary" onClick={() => loginAction(api.engineCancelLogin(id))}>Cancel sign-in</button></div>}
          </div>
        })}
      </div>
      <div className="onboard-preferences">
        <div><label className="setting-row"><span>Learn where you work</span><input type="checkbox" className="switch" data-testid="onboard-work-map" aria-describedby="work-map-consent" checked={learnWork} onChange={event => setLearnWork(event.target.checked)} /></label><p className="setting-hint" id="work-map-consent">Site names and titles from browser history and bookmarks go to your AI daily. No pages opened.</p></div>
        <div><label className="setting-row"><span>Personalize Engram</span><input type="checkbox" className="switch" data-testid="onboard-interview" aria-describedby="interview-consent" checked={interview} onChange={event => setInterview(event.target.checked)} /></label><p className="setting-hint" id="interview-consent">Optional questions. File and site names go to your AI, not contents.</p></div>
      </div>
      <div className="onboard-actions"><button className="secondary" disabled={finishing || !!connecting || installing} onClick={() => setStep(1)}>Back</button><button className={ready.length ? 'primary' : 'secondary'} data-testid={ready.length ? 'onboard-finish' : 'onboard-skip-ai'} disabled={finishing || !!connecting || installing} onClick={() => void finish()}>{finishing ? <><LoaderCircle size={14} className="computer-spinner" aria-hidden />Creating workspace…</> : ready.length ? 'Start using Engram' : 'Continue without AI'}</button></div>
    </section>}
    {error && <div className="onboard-fail" role="alert">{error}{step === 2 && <button className="secondary" data-testid="onboard-brains-retry" disabled={loading || !!connecting} onClick={() => { setError(''); void loadBrains() }}>Check connections again</button>}</div>}
  </div></div>
}
