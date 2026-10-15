import { Check, ExternalLink, Folder, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { EngineLoginDto, EngineStatusDto } from '../../../shared/types.js'
import { api, apiErrorText } from '../api.js'
import { INTERVIEW_PENDING_KEY } from '../components/WorkInterview.js'
import { ProviderIcon } from '../components/ProviderIcon.js'
import { InstallClaude } from '../components/InstallClaude.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'
import { refreshAccountUsage, useAccountUsage } from '../lib/accountUsage.js'
import { LearningSources, type LearningChoice } from '../components/LearningSources.js'
import { connectionConfirmed, connectionLabel } from '../lib/connectionStatus.js'
import { useModelChoices } from '../components/ModelPicker.js'
import { OnboardingModel } from '../components/OnboardingModel.js'

export function Onboarding() {
  const profiles = useAccountProfiles()
  const [step, setStep] = useState(1)
  const [root, setRoot] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [brains, setBrains] = useState<EngineStatusDto[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [checkFailed, setCheckFailed] = useState<string | null>(null)
  const [connecting, setConnecting] = useState<'claude' | 'codex' | null>(null)
  const [installing, setInstalling] = useState(false)
  const [logins, setLogins] = useState<EngineLoginDto[]>([])
  // Nothing new is read unless chosen here; the activity log keeps its current state.
  const [sources, setSources] = useState<LearningChoice>({ workMap: false, workFiles: false, workApps: false, activity: true })
  const [interview, setInterview] = useState(true)
  const [computerUse, setComputerUse] = useState(false)
  // Which connected AI answers first. Chosen here, never guessed from the order of sign-in.
  const [choice, setChoice] = useState<'claude' | 'codex' | null>(null)
  const [model, setModel] = useState<string | null>(null)
  const catalog = useModelChoices(choice)
  const usage = useAccountUsage()
  const revision = useRef(0)
  // Only the first check shows spinners; later ones refresh behind what is shown.
  const checked = useRef(false)
  const signing = useRef(false)
  const completing = useRef(false)
  const ready = brains.filter(connectionConfirmed)
  // A signed-in account at its usage limit is connected but cannot answer now.
  const limited = (id: 'claude' | 'codex') => usage.some(account => account.provider === id && account.profile === (profiles?.selected[id] ?? 'system') && (account.usage?.windows ?? []).some(window => (window.used ?? 0) >= 100 && (window.resetsAt === undefined || window.resetsAt > Date.now())))
  const pick = choice && ready.some(brain => brain.id === choice) ? choice : null
  const modelReady = !!pick && !catalog.loading && !catalog.error && catalog.rows.length > 0 && model !== null && (model === '' || catalog.rows.some(row => row.value === model))

  const loadBrains = async () => {
    const at = ++revision.current
    if (!checked.current) setLoading(true)
    try { const states = await api.engineStates(); if (at === revision.current) { setBrains(states); checked.current = true } }
    catch { if (at === revision.current) setError('Could not check AI connections. Please retry before continuing.') }
    finally { if (at === revision.current) setLoading(false) }
  }
  useEffect(() => {
    void api.onboardDefaults().then(value => setRoot(held => held || value.defaultRoot)).catch(() => setError('Could not find your default folder. Choose a folder below.'))
    void loadBrains()
    void refreshAccountUsage(true).catch(() => undefined)
    void api.activityGet().then(activity => setSources(held => ({ ...held, activity }))).catch(() => undefined)
    void api.engineLogins().then(setLogins).catch(() => undefined)
    return api.onEvent(event => {
      if (event.type === 'engines:changed' || event.type === 'engines:detected') void loadBrains()
      if (event.type === 'engines:login') setLogins(held => [...held.filter(login => login.id !== event.login.id || login.profile !== event.login.profile), event.login])
    })
  }, [])

  const connect = async (id: 'claude' | 'codex') => {
    if (signing.current) return
    signing.current = true; setConnecting(id); setError(''); setCheckFailed(null)
    try {
      const result = await api.engineConnect(id)
      if (!result.ok) setError(result.message || 'Sign-in was cancelled. Please try again.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in did not finish. Please try again.') }
    finally { signing.current = false; setConnecting(null); await loadBrains() }
  }
  const finish = async () => {
    if (completing.current || signing.current || installing || loading || !root.trim() || !pick || !modelReady || model === null) return
    completing.current = true; setFinishing(true); setError(''); setCheckFailed(null)
    try {
      const states = await api.engineStates([pick])
      const available = states.find(brain => brain.id === pick && connectionConfirmed(brain))
      setBrains(held => [...held.filter(brain => brain.id !== pick), ...states])
      if (!available) throw new Error('Your AI connection is not verified. Connect it and try again.')
      if (available && (available.id === 'claude' || available.id === 'codex')) {
        await api.settingsSet({ defaultEngine: available.id, [available.id === 'codex' ? 'codexModel' : 'claudeModel']: model })
        await api.aiSelectionSet('filing', { engine: available.id, model })
      }
      const latest = await api.settingsGet()
      const chosen = { workMap: sources.workMap, workFiles: sources.workFiles, workApps: sources.workApps, computerUse }
      if ((Object.keys(chosen) as (keyof typeof chosen)[]).some(key => latest[key] !== chosen[key])) await api.settingsSet(chosen)
      if (await api.activityGet() !== sources.activity) await api.activitySet(sources.activity)
      try { if (interview && available) localStorage.setItem(INTERVIEW_PENDING_KEY, '1'); else localStorage.removeItem(INTERVIEW_PENDING_KEY) } catch { /* the interview stays in Settings */ }
      await api.onboardComplete({ root: root.trim(), importFolder: null, teamUrl: null, firstCapture: null })
    }
    catch (cause) { const message = apiErrorText(cause instanceof Error ? cause.message : 'Could not finish setup. Please try again.'); completing.current = false; setFinishing(false); const aiFailed = /AI|Claude|ChatGPT|connection/i.test(message); setCheckFailed(aiFailed ? pick : null); if (aiFailed) setStep(2); setError(message) }
  }
  const loginAction = (action: Promise<unknown>) => void action.catch(() => setError('Could not update the sign-in window. Please try again.'))

  return <div className="onboarding" data-testid="onboarding"><div className="onboard-card">
    <div className="onboard-progress" aria-label={`Step ${step} of 3`}><strong>Engram</strong><span>{step} / 3</span></div>
    {step === 1 ? <section data-testid="onboard-step-1">
      <h1>Choose your workspace</h1>
      <div className="onboard-folder">
        <div className="onboard-folder-path">
        <Folder size={18} aria-hidden />
        <input id="onboard-root" aria-label="Workspace folder" data-testid="vault-root-input" value={root} placeholder="Workspace folder" onChange={event => setRoot(event.target.value)} />
        </div>
        <button className="secondary" aria-label="Choose workspace folder" onClick={() => void api.importPick().then(value => { if (value) setRoot(value) }).catch(() => setError('Could not open the folder picker.'))}>Choose…</button>
      </div>
      <div className="onboard-actions"><button className="primary" data-testid="onboard-next" disabled={!root.trim()} onClick={() => { setError(''); setStep(2) }}>Continue</button></div>
    </section> : step === 2 ? <section className="onboard-ai" data-testid="onboard-step-2">
      <h1>Connect your AI</h1>
      <div className="onboard-ai-content">
      <div className="onboard-providers" aria-busy={loading}>
        {(['claude', 'codex'] as const).map(id => {
          const state = brains.find(brain => brain.id === id)
          const login = logins.find(item => item.id === id && (item.profile ?? 'system') === (profiles?.selected[id] ?? 'system'))
          const connected = connectionConfirmed(state)
          const active = connecting === id
          return <div className="onboard-provider" key={id}>
            <ProviderIcon provider={id} size={24} />
            <div className="onboard-provider-info"><strong>{id === 'claude' ? 'Claude' : 'ChatGPT'}</strong>{active && <span role="status">{login?.phase === 'browser' ? 'Finish in your browser' : 'Opening sign-in…'}</span>}{!loading && !active && id === 'codex' && state && !state.installed && <span>Reinstall Engram to connect.</span>}{!loading && !active && connected && limited(id) && <span role="status" data-testid={`onboard-limited-${id}`}>A reported account limit is full. Test this model or choose another AI.</span>}{!loading && !active && !connected && state?.installed && <span>{connectionLabel(state, id)}</span>}</div>
            {active ? <div className="onboard-signing"><LoaderCircle size={18} className="computer-spinner" aria-label="Signing in" /><button type="button" className="onboard-cancel" aria-label="Cancel sign-in" title="Cancel sign-in" onClick={() => loginAction(api.engineCancelLogin(id))}><X size={16} aria-hidden /></button></div> : loading ? <LoaderCircle size={18} className="computer-spinner" aria-label="Checking connection" /> : connected ? <span className={checkFailed === id ? 'setting-hint' : 'onboard-connected'} data-testid={`onboard-brain-${id}`} role="status">{checkFailed !== id && <Check size={15} aria-hidden />}{checkFailed === id ? 'Check failed' : 'Signed in'}</span> : state?.conclusive === false ? <button className="secondary" disabled={finishing} onClick={() => { checked.current = false; void loadBrains() }}>Retry check</button> : id === 'claude' && state && !state.installed ? <InstallClaude onInstalled={() => void loadBrains()} onBusy={setInstalling} /> : <button className="secondary" data-testid={`onboard-connect-${id}`} disabled={!!connecting || !state?.installed || finishing || installing} onClick={() => void connect(id)}>Connect</button>}
            {active && login?.canOpen && <div className="onboard-login-actions"><button className="secondary" onClick={() => loginAction(api.engineOpenLogin(id))}><ExternalLink size={13} aria-hidden />Open browser</button></div>}
          </div>
        })}
      </div>
      <fieldset className="onboard-choice" data-testid="onboard-choice"><legend>Your AI for conversations &amp; Cosmos</legend>{(['claude', 'codex'] as const).map(id => <label className="onboard-choice-card" key={id} data-selected={pick === id}><input type="radio" name="onboard-brain" value={id} data-testid={`onboard-choose-${id}`} checked={pick === id} disabled={finishing || !ready.some(brain => brain.id === id)} onChange={() => { setChoice(id); setModel(null); setCheckFailed(null) }} /><ProviderIcon provider={id} size={18} /><span>{id === 'claude' ? 'Claude' : 'ChatGPT'}</span><Check size={16} className="onboard-choice-check" aria-hidden /></label>)}{pick && <OnboardingModel {...catalog} value={model} disabled={finishing} onChange={value => { setModel(value); setCheckFailed(null) }} />}</fieldset>
      </div>
      <div className="onboard-actions"><button className="secondary" disabled={!!connecting || installing} onClick={() => { setError(''); setStep(1) }}>Back</button><button className="primary" data-testid="onboard-ai-next" disabled={loading || !!connecting || installing || !modelReady} onClick={() => { setError(''); setStep(3) }}>Continue</button></div>
    </section> : <section className="onboard-ai" data-testid="onboard-step-3">
      <h1>Make it yours</h1>
      <div className="onboard-ai-content onboard-preferences">
        <LearningSources compact value={sources} disabled={finishing} testPrefix="onboard" onChange={(key, on) => setSources(held => ({ ...held, [key]: on }))} />
        <div><label className="setting-row"><span>Personalize Engram</span><input type="checkbox" className="switch" data-testid="onboard-interview" aria-describedby="interview-consent" checked={interview} disabled={finishing} onChange={event => setInterview(event.target.checked)} /></label><p className="setting-hint" id="interview-consent">Optional questions from selected notes and past tasks. No new document scan.</p></div>
        <div><label className="setting-row"><span>Control desktop apps</span><input type="checkbox" className="switch" data-testid="onboard-computer-use" checked={computerUse} disabled={finishing} onChange={event => setComputerUse(event.target.checked)} /></label><p className="setting-hint">Uses your mouse and keyboard. App text and screenshots go to your AI. Esc stops control; sign-in stays manual.</p></div>
      </div>
      <div className="onboard-actions"><button className="secondary" disabled={finishing} onClick={() => { setError(''); setStep(2) }}>Back</button><button className="primary" data-testid="onboard-finish" disabled={finishing || !modelReady} onClick={() => void finish()}>{finishing ? <><LoaderCircle size={14} className="computer-spinner" aria-hidden />Checking AI…</> : 'Start Engram'}</button></div>
    </section>}
    {error && <div className="onboard-fail" role="alert">{error}{step === 2 && <button className="secondary" data-testid="onboard-brains-retry" disabled={loading || !!connecting} onClick={() => { setError(''); void loadBrains() }}>Check connections again</button>}</div>}
  </div></div>
}
