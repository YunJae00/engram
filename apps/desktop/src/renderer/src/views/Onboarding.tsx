import { useEffect, useState } from 'react'
import type { EngineStatusDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'

export function Onboarding() {
  const [step, setStep] = useState(1)
  const [root, setRoot] = useState('')
  const [importFolder, setImportFolder] = useState<string | null>(null)
  const [importCount, setImportCount] = useState(0)
  const [teamUrl, setTeamUrl] = useState('')
  const [firstCapture, setFirstCapture] = useState('')
  const [finishing, setFinishing] = useState(false)
  const [brains, setBrains] = useState<EngineStatusDto[]>([])
  const [brainsFailed, setBrainsFailed] = useState(false)
  const [connecting, setConnecting] = useState<'claude' | 'codex' | null>(null)
  const [imported, setImported] = useState<{ done: number; total: number } | null>(null)

  // A failed state fetch must not leave step 2 as a title over an empty
  // list — without the retry the user proceeds brainless, never having seen
  // a sign-in button.
  const loadBrains = () => {
    setBrainsFailed(false)
    void api
      .engineStates()
      .then(setBrains)
      .catch(() => setBrainsFailed(true))
  }

  const connect = async (id: 'claude' | 'codex') => {
    setConnecting(id)
    await api.engineConnect(id).catch(() => undefined)
    setConnecting(null)
    loadBrains()
  }

  useEffect(() => {
    void api.onboardDefaults().then((d) => setRoot(d.defaultRoot))
    loadBrains()
    return api.onEvent((event) => {
      if (event.type === 'engines:changed') loadBrains()
      else if (event.type === 'import:progress') {
        // The finishing step blocks on the whole import; without this the user
        // watches a disabled button for minutes with no count.
        setImported({ done: event.done, total: event.total })
      }
    })
  }, [])

  const pickImport = async () => {
    const folder = await api.importPick()
    if (!folder) return
    const scan = await api.importScan(folder)
    setImportFolder(folder)
    setImportCount(scan.count)
  }

  const finish = async () => {
    setFinishing(true)
    try {
      await api.onboardComplete({
        root,
        importFolder,
        teamUrl: teamUrl.trim() || null,
        firstCapture: firstCapture.trim() || null,
      })
      // main reloads this window into the shell
    } catch (err) {
      setFinishing(false)
      window.alert(`${t('onboard.setupError')}\n\n${String(err).slice(0, 500)}`)
    }
  }

  return (
    <div className="onboarding" data-testid="onboarding">
      <div className="onboard-card">
        <div className="onboard-steps">
          {[1, 2, 3, 4, 5].map((n) => (
            <span key={n} className={`step-dot${n === step ? ' active' : ''}${n < step ? ' done' : ''}`} />
          ))}
        </div>

        {step === 1 && (
          <section data-testid="onboard-step-1">
            <h1>{t('onboard.s1Title')}</h1>
            <p className="onboard-sub">{t('onboard.s1Sub')}</p>
            <input data-testid="vault-root-input" value={root} onChange={(e) => setRoot(e.target.value)} />
            <div className="onboard-actions">
              <button className="primary" data-testid="onboard-next" disabled={!root.trim()} onClick={() => setStep(2)}>
                {t('onboard.continue')}
              </button>
            </div>
          </section>
        )}

        {step === 2 && (
          <section data-testid="onboard-step-2">
            <h1>{t('onboard.s2Title')}</h1>
            <p className="onboard-sub">{t('onboard.s2Sub')}</p>
            <ul className="engine-lights">
              {(['claude', 'codex'] as const).map((id) => {
                const state = brains.find((b) => b.id === id)
                const signedIn = state?.installed === true && state.loggedIn
                return (
                  <li key={id} className={signedIn ? 'engine-ready' : ''}>
                    <span className={`engine-dot${signedIn ? ' on' : ''}`} />
                    <span className="engine-name">{t(id === 'claude' ? 'settings.brainClaude' : 'settings.brainChatGPT')}</span>
                    <span className="engine-pill" data-testid={`onboard-brain-${id}`}>
                      {connecting === id
                        ? t('settings.brainConnecting')
                        : signedIn
                          ? t('settings.brainConnected')
                          : state?.installed
                            ? (
                                <button className="secondary" data-testid={`onboard-connect-${id}`} onClick={() => void connect(id)}>
                                  {t('settings.brainConnect')}
                                </button>
                              )
                            : t('settings.brainMissing')}
                    </span>
                  </li>
                )
              })}
            </ul>
            {brainsFailed && (
              <p className="onboard-fail">
                {t('onboard.brainsUnavailable')}{' '}
                <button className="secondary" data-testid="onboard-brains-retry" onClick={loadBrains}>
                  {t('onboard.brainsRetry')}
                </button>
              </p>
            )}
            <p className="onboard-note">{t('onboard.brainNote')}</p>
            <div className="onboard-actions">
              <button className="secondary" data-testid="onboard-skip-ai" onClick={() => setStep(3)}>
                {t('onboard.skipForNow')}
              </button>
              <button className="primary" data-testid="onboard-next" onClick={() => setStep(3)}>
                {t('onboard.continue')}
              </button>
            </div>
          </section>
        )}

        {step === 3 && (
          <section data-testid="onboard-step-3">
            <h1>{t('onboard.s3Title')}</h1>
            <p className="onboard-sub">{t('onboard.s3Sub')}</p>
            {importFolder ? (
              <p>
                <strong>{importCount}</strong> {t('onboard.filesFrom')} <code>{importFolder}</code>
              </p>
            ) : (
              <button className="secondary" onClick={() => void pickImport()}>
                {t('onboard.chooseFolder')}
              </button>
            )}
            <div className="onboard-actions">
              <button className="secondary" data-testid="onboard-skip-import" onClick={() => { setImportFolder(null); setStep(4) }}>
                {t('onboard.skip')}
              </button>
              <button className="primary" data-testid="onboard-next" onClick={() => setStep(4)}>
                {t('onboard.continue')}
              </button>
            </div>
          </section>
        )}

        {step === 4 && (
          <section data-testid="onboard-step-4">
            <h1>{t('onboard.s4Title')}</h1>
            <p className="onboard-sub">{t('onboard.s4Sub')}</p>
            <input placeholder={t('onboard.invitePlaceholder')} value={teamUrl} onChange={(e) => setTeamUrl(e.target.value)} />
            <div className="onboard-actions">
              <button className="secondary" data-testid="onboard-skip-team" onClick={() => { setTeamUrl(''); setStep(5) }}>
                {t('onboard.later')}
              </button>
              <button className="primary" data-testid="onboard-next" onClick={() => setStep(5)}>
                {t('onboard.continue')}
              </button>
            </div>
          </section>
        )}

        {step === 5 && (
          <section data-testid="onboard-step-5">
            <h1>{t('onboard.s5Title')}</h1>
            <p className="onboard-sub">{t('onboard.s5Sub')}</p>
            <textarea
              data-testid="first-capture-input"
              rows={4}
              placeholder={t('onboard.firstPlaceholder')}
              value={firstCapture}
              onChange={(e) => setFirstCapture(e.target.value)}
            />
            <div className="onboard-actions">
              <button className="primary" data-testid="onboard-finish" disabled={finishing} onClick={() => void finish()}>
                {finishing
                  ? imported
                    ? t('onboard.importing', { done: imported.done, total: imported.total })
                    : t('onboard.settingUp')
                  : t('onboard.start')}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
