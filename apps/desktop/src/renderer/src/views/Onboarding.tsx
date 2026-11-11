import { Check, ExternalLink, Folder, LoaderCircle, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { EngineLoginDto, EngineStatusDto } from '../../../shared/types.js'
import { api, apiErrorText } from '../api.js'
import { ProviderIcon } from '../components/ProviderIcon.js'
import { InstallClaude } from '../components/InstallClaude.js'
import { useAccountProfiles } from '../lib/accountProfiles.js'
import { refreshAccountUsage, useAccountUsage } from '../lib/accountUsage.js'
import { LearningSources, type LearningChoice } from '../components/LearningSources.js'
import { connectionConfirmed, connectionLabel } from '../lib/connectionStatus.js'
import { useModelChoices } from '../components/ModelPicker.js'
import { OnboardingModel } from '../components/OnboardingModel.js'
import { BotAvatar, useAvatarTheme } from '../components/BotAvatar.js'
import { clipLabel } from '../lib/createBot.js'
import { ONBOARD_BOT_KEY, saveOnboardBot, type OnboardBot } from '../lib/onboardBot.js'
import { t } from '../i18n.js'

const CHECK_ERROR = 'Could not check AI connections. Please retry before continuing.'

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
  const primary = useRef<HTMLButtonElement>(null)
  const [botName, setBotName] = useState('Engram')
  const [botLabel, setBotLabel] = useState('')
  const activityAtMount = useRef(true)
  const avatarTheme = useAvatarTheme()
  const ready = brains.filter(connectionConfirmed)
  // A signed-in account at its usage limit is connected but cannot answer now.
  const limited = (id: 'claude' | 'codex') => usage.some(account => account.provider === id && account.profile === (profiles?.selected[id] ?? 'system') && (account.usage?.windows ?? []).some(window => (window.used ?? 0) >= 100 && (window.resetsAt === undefined || window.resetsAt > Date.now())))
  const pick = choice && ready.some(brain => brain.id === choice) ? choice : null
  const modelReady = !!pick && !catalog.loading && !catalog.error && catalog.rows.length > 0 && model !== null && (model === '' || catalog.rows.some(row => row.value === model))

  // `fresh` re-detects past main-process status caches, for a CLI login finished outside the app.
  const loadBrains = async (fresh = false): Promise<EngineStatusDto[] | null> => {
    const at = ++revision.current
    if (!checked.current) setLoading(true)
    try { const states = await api.engineStates(fresh ? [] : undefined); if (at !== revision.current) return null; setBrains(states); setError(held => held === CHECK_ERROR ? '' : held); checked.current = true; return states }
    catch { if (at === revision.current) setError(CHECK_ERROR); return null }
    finally { if (at === revision.current) setLoading(false) }
  }
  useEffect(() => {
    void api.onboardDefaults().then(value => setRoot(held => held || value.defaultRoot)).catch(() => setError('Could not suggest a folder. Choose one to continue.'))
    void loadBrains()
    void refreshAccountUsage(true).catch(() => undefined)
    void api.activityGet().then(activity => setSources(held => ({ ...held, activity }))).catch(() => undefined)
    void api.engineLogins().then(setLogins).catch(() => undefined)
    const refocus = () => { if (!signing.current && !completing.current) void loadBrains(true) }
    window.addEventListener('focus', refocus)
    const off = api.onEvent(event => {
      if ((event.type === 'engines:changed' || event.type === 'engines:detected') && !signing.current) void loadBrains()
      if (event.type === 'engines:login') setLogins(held => [...held.filter(login => login.id !== event.login.id || login.profile !== event.login.profile), event.login])
    })
    return () => { window.removeEventListener('focus', refocus); off() }
  }, [])
  useEffect(() => { void api.activityGet().then(activity => { activityAtMount.current = activity }).catch(() => undefined) }, [])

  const connect = async (id: 'claude' | 'codex') => {
    if (signing.current) return
    signing.current = true; setConnecting(id); setError(''); setCheckFailed(null)
    try {
      const states = await loadBrains(true)
      if (states?.some(brain => brain.id === id && connectionConfirmed(brain))) return
      setError('')
      const result = await api.engineConnect(id)
      if (!result.ok) setError(result.message || 'Sign-in was cancelled. Please try again.')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Sign-in did not finish. Please try again.') }
    finally { signing.current = false; setConnecting(null); await loadBrains() }
  }
  const finish = async (bot: OnboardBot) => {
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
      const chosen = { workMap: sources.workMap, workFiles: sources.workFiles, workApps: sources.workApps }
      if ((Object.keys(chosen) as (keyof typeof chosen)[]).some(key => latest[key] !== chosen[key])) await api.settingsSet(chosen)
      if (await api.activityGet() !== sources.activity) await api.activitySet(sources.activity)
      saveOnboardBot(bot)
      await api.onboardComplete({ root: root.trim(), importFolder: null, teamUrl: null, firstCapture: null })
    }
    catch (cause) { localStorage.removeItem(ONBOARD_BOT_KEY); const message = apiErrorText(cause instanceof Error ? cause.message : 'Could not finish setup. Please try again.'); completing.current = false; setFinishing(false); const aiFailed = /AI|Claude|ChatGPT|connection/i.test(message); setCheckFailed(aiFailed ? pick : null); if (aiFailed) setStep(2); setError(message) }
  }
  const loginAction = (action: Promise<unknown>) => void action.catch(() => setError('Could not update the sign-in window. Please try again.'))

  return <div className="onboarding" data-testid="onboarding"><div className="onboard-card">
    <div className="onboard-progress" aria-label={`Step ${step} of 4`}><strong>Engram</strong><span>{step} / 4</span></div>
    {step === 1 ? <section data-testid="onboard-step-1">
      <h1>Choose a workspace folder</h1>
      <div className="onboard-folder">
        <div className="onboard-folder-path">
        <Folder size={18} aria-hidden />
        <input id="onboard-root" aria-label="Workspace folder" data-testid="vault-root-input" value={root} placeholder="Folder path" onChange={event => setRoot(event.target.value)} />
        </div>
        <button className="secondary" aria-label="Browse for workspace folder" onClick={() => void api.importPick().then(value => { if (value) setRoot(value) }).catch(() => setError('Could not open the folder picker. Type a path instead.'))}>Browse…</button>
      </div>
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
      <fieldset className="onboard-choice" data-testid="onboard-choice"><legend>Your AI for conversations &amp; Cosmos</legend>{(['claude', 'codex'] as const).map(id => <label className="onboard-choice-card" key={id} data-selected={pick === id}><input type="radio" name="onboard-brain" value={id} data-testid={`onboard-choose-${id}`} checked={pick === id} disabled={finishing || !ready.some(brain => brain.id === id)} onChange={() => { setChoice(id); setModel(null); setCheckFailed(null) }} /><ProviderIcon provider={id} size={18} /><span>{id === 'claude' ? 'Claude' : 'ChatGPT'}</span><Check size={16} className="onboard-choice-check" aria-hidden /></label>)}<div className="onboard-model-reveal" data-open={!!pick}><div>{pick && <OnboardingModel {...catalog} value={model} disabled={finishing} onChange={value => { setModel(value); setCheckFailed(null) }} />}</div></div></fieldset>
      </div>
    </section> : step === 3 ? <section className="onboard-ai" data-testid="onboard-step-3">
      <h1>Make it yours</h1>
      <div className="onboard-ai-content onboard-preferences" aria-busy={finishing}>
        <LearningSources compact value={sources} disabled={finishing} testPrefix="onboard" onChange={(key, on) => setSources(held => ({ ...held, [key]: on }))} />
      </div>
    </section> : <section className="onboard-ai" data-testid="onboard-step-4">
      <h1>{t('onboard.botTitle')}</h1>
      <div className="onboard-ai-content onboard-bot">
        <BotAvatar id="onboard-primary" primary size={64} state="idle" theme={avatarTheme} />
        <label className="onboard-bot-field"><span>{t('createBot.name')}</span><input data-testid="onboard-bot-name" value={botName} maxLength={60} disabled={finishing} onChange={event => setBotName(event.target.value)} /></label>
        <label className="onboard-bot-field"><span>{t('onboard.botLabel')}</span><input data-testid="onboard-bot-label" value={botLabel} disabled={finishing} onChange={event => setBotLabel(clipLabel(event.target.value))} /></label>
      </div>
    </section>}
    {error && <div className="onboard-fail" role="alert">{error}{step === 2 && <button className="secondary" data-testid="onboard-brains-retry" disabled={loading || !!connecting} onClick={() => { setError(''); void loadBrains() }}>Check connections again</button>}</div>}
    {/* One persistent bar: step changes rewrite these nodes instead of remounting them under the cursor. */}
    <div className="onboard-actions">
      {step > 1 && <button className="secondary" disabled={step === 2 ? !!connecting || installing : finishing} onClick={event => { if (event.detail > 1) return; if (step === 2 && event.detail === 0) primary.current?.focus(); setError(''); setStep(step - 1) }}>Back</button>}
      {step === 3 && <button className="onboard-skip" data-testid="onboard-prefs-skip" disabled={finishing} onClick={() => { setSources({ workMap: false, workFiles: false, workApps: false, activity: activityAtMount.current }); setError(''); setStep(4) }}>{t('onboard.skip')}</button>}
      {step === 4 && <button className="onboard-skip" data-testid="onboard-bot-skip" disabled={finishing || !modelReady} onClick={() => void finish({ name: null, label: null })}>{t('onboard.skip')}</button>}
      <button ref={primary} className="primary" data-testid={step === 1 ? 'onboard-next' : step === 2 ? 'onboard-ai-next' : step === 3 ? 'onboard-prefs-next' : 'onboard-finish'} disabled={step === 1 ? !root.trim() : step === 2 ? loading || !!connecting || installing || !modelReady : finishing || !modelReady} onClick={event => { if (event.detail > 1) return; if (step === 4) { void finish({ name: botName, label: botLabel }); return } setError(''); setStep(step + 1) }}>
        {step === 4 && finishing ? <><LoaderCircle size={14} className="computer-spinner" aria-hidden />Checking AI…</> : step === 4 ? 'Start Engram' : 'Continue'}
      </button>
    </div>
  </div></div>
}
