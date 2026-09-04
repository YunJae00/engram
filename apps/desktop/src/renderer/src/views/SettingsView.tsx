import { useEffect, useState } from 'react'
import type { AppSettingsDto, EngineStatusDto, SemanticStatusDto, UpdateCheckDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import { DiagnosticsView } from './DiagnosticsView.js'
import { useModelChoices } from '../components/ModelPicker.js'

const BRAIN_NAME = { claude: 'settings.brainClaude', codex: 'settings.brainChatGPT' } as const
// The sheet opens at once, empty, and its rows fill in together when every
// one of them knows its state - none of them is shown half-known. A load
// that hangs does not keep the rows blank for good.
const READY_WAIT_MS = 8_000
const SKELETON_ROWS = 7

export function SettingsView({ onClose }: { onClose(): void }) {
  const { showToast, t } = useApp()
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [deskJournal, setDeskJournal] = useState<boolean | null>(null)
  const [sessionWatch, setSessionWatch] = useState<boolean | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [mcpStatus, setMcpStatus] = useState<string | null>(null)
  const [semantic, setSemantic] = useState<SemanticStatusDto | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateCheckDto | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  // Every brain this build carries, signed in or not - the cloud rows read
  // their state off this, and the sign-in flows refresh it.
  const [brains, setBrains] = useState<EngineStatusDto[]>([])
  const [connecting, setConnecting] = useState<'claude' | 'codex' | null>(null)
  const claudeChoices = useModelChoices()
  const [connectFail, setConnectFail] = useState<Record<string, string>>({})
  const refreshBrains = () => void api.engineStates().then(setBrains).catch(() => {})
  const connect = async (id: 'claude' | 'codex') => {
    setConnecting(id)
    setConnectFail((prior) => ({ ...prior, [id]: '' }))
    const result = await api.engineConnect(id).catch((err: unknown) => ({ ok: false, message: String((err as Error).message ?? err) }))
    setConnecting(null)
    if (!result.ok) setConnectFail((prior) => ({ ...prior, [id]: result.message ?? t('settings.brainConnectFailed') }))
    refreshBrains()
  }
  const disconnect = async (id: 'claude' | 'codex') => {
    await api.engineDisconnect(id).catch(() => undefined)
    refreshBrains()
  }
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const loads = [
      api.settingsGet().then(setSettings),
      api.appVersion().then(setVersion),
      api.engineStates().then(setBrains),
      api.activityGet().then(setDeskJournal),
      api.sessionWatchGet().then(setSessionWatch),
      // What the updater already knows, shown without a click — a downloaded
      // update used to hide behind Check now.
      api.updateState().then(setUpdate),
      api.semanticStatus().then(setSemantic),
    ]
    void Promise.allSettled(loads).then(() => setReady(true))
    const fallback = setTimeout(() => setReady(true), READY_WAIT_MS)
    const off = api.onEvent((event) => {
      if (event.type === 'update:ready') {
        setUpdate({ state: 'ready', version: event.version, selfInstalls: event.selfInstalls })
      }
    })
    return () => {
      clearTimeout(fallback)
      off()
    }
  }, [])

  // While the download runs, the percent moves — follow it, and catch the
  // flip to ready even if the broadcast landed before this sheet opened.
  useEffect(() => {
    if (update?.state !== 'downloading') return
    const timer = setInterval(() => void api.updateState().then(setUpdate).catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [update?.state])

  // One action for both clients, reporting per-client in place (no toast — the
  // sheet stays open). A client that is not installed is not a failure worth
  // shouting about: it just does not appear in the connected list.
  const reconnectMcp = async () => {
    setMcpStatus(t('settings.mcpWorking'))
    let desktop, code
    try {
      ;[desktop, code] = await Promise.all([api.mcpConnectDesktop(), api.mcpConnectCode()])
    } catch (err) {
      setMcpStatus(t('settings.mcpFailedList', { names: String((err as Error).message ?? err).slice(0, 120) }))
      return
    }
    const ok: string[] = []
    const failed: string[] = []
    for (const [name, result] of [
      [t('settings.mcpDesktop'), desktop],
      [t('settings.mcpCode'), code],
    ] as const) {
      if (result.ok) ok.push(name)
      else if (result.code !== 'not-installed' && result.code !== 'no-cli') {
        failed.push(result.detail ? `${name} (${result.detail})` : name)
      }
    }
    if (failed.length > 0) setMcpStatus(t('settings.mcpFailedList', { names: failed.join(', ') }))
    else if (ok.length > 0) setMcpStatus(t('settings.mcpConnected', { names: ok.join(', ') }))
    else setMcpStatus(t('settings.mcpNoClients'))
  }

  const copyMcpConfig = async () => {
    try {
      const info = await api.mcpInfo()
      await navigator.clipboard.writeText(info.configJson)
      setMcpStatus(t('settings.mcpCopied'))
    } catch (err) {
      setMcpStatus(t('settings.mcpCopyFailed', { reason: String((err as Error).message ?? err).slice(0, 120) }))
    }
  }

  // Semantic layer status refreshes while the sheet is open — model
  // download/indexing progress is worth watching live.
  useEffect(() => {
    const timer = setInterval(() => void api.semanticStatus().then(setSemantic).catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [])

  // Escape closes settings — but yields while the diagnostics overlay is
  // stacked on top (that one handles its own Escape).
  useEscape(onClose, !showDiagnostics)

  if (!settings || !ready)
    return (
      <div className="brief-overlay" onClick={onClose}>
        <div className="brief-box settings-box" data-testid="settings-loading" onClick={(e) => e.stopPropagation()} aria-busy>
          <div className="brief-title">{t('settings.title')}</div>
          <div className="settings-skeleton">
            {Array.from({ length: SKELETON_ROWS }, (_, i) => (
              <div key={i} className="settings-skeleton-row">
                <span className="skeleton-line" style={{ width: `${28 + ((i * 17) % 30)}%` }} />
                <span className="skeleton-line short" />
              </div>
            ))}
          </div>
        </div>
      </div>
    )
  const patch = (p: Partial<AppSettingsDto>) => setSettings({ ...settings, ...p })

  const save = async () => {
    try {
      await api.settingsSet(settings)
    } catch (err) {
      showToast(t('toast.settingsFailed', { reason: String((err as Error).message ?? err).slice(0, 120) }))
      return
    }
    showToast(t('toast.settingsSaved'))
    onClose()
  }

  return (
    <div className="brief-overlay" onClick={onClose}>
      {/* settings-loaded: the skeleton gives way with a short rise instead
          of the rows swapping between two frames. */}
      <div className="brief-box settings-box settings-loaded" onClick={(e) => e.stopPropagation()} data-testid="settings-view">
        <div className="brief-title">{t('settings.title')}</div>

        {/* ⑥ the quick-capture hotkey is fixed now, and ⑧ team sync moved into
            the GitHub backup dialog — it decides whether to auto-push to a
            remote only that dialog can create, and with no remote it silently
            did nothing three sections away from what it depends on. */}

        <div className="settings-group">
          <label className="setting-row">
            <span>{t('settings.autoStart')}</span>
            <input
              type="checkbox"
              className="switch"
              data-testid="setting-autostart"
              checked={settings.autoStart}
              onChange={(e) => patch({ autoStart: e.target.checked })}
            />
          </label>
          <label className="setting-row">
            <span>{t('settings.deskJournal')}</span>
            <input
              type="checkbox"
              className="switch"
              data-testid="setting-desk-journal"
              checked={deskJournal ?? false}
              onChange={(e) =>
                void api
                  .activitySet(e.target.checked)
                  .then(setDeskJournal)
                  .catch(() => void api.activityGet().then(setDeskJournal))
              }
            />
          </label>
          <label className="setting-row">
            <span>{t('settings.sessionWatch')}</span>
            <input
              type="checkbox"
              className="switch"
              data-testid="setting-session-watch"
              checked={sessionWatch ?? false}
              onChange={(e) =>
                void api
                  .sessionWatchSet(e.target.checked)
                  .then(setSessionWatch)
                  .catch(() => void api.sessionWatchGet().then(setSessionWatch))
              }
            />
          </label>
        </div>
        <div className="settings-group-head">{t('settings.brainTitle')}</div>
        <div className="settings-group">
          <div className="setting-note">{t('settings.brainHint')}</div>
          <div className="brain-pick" role="radiogroup" aria-label={t('settings.brainUse')}>
            {(['claude', 'codex'] as const).map((id) => (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={settings.defaultEngine === id}
                className={`secondary brain-choice${settings.defaultEngine === id ? ' armed' : ''}`}
                data-testid={`brain-use-${id}`}
                onClick={() => patch({ defaultEngine: id })}
              >
                {t(BRAIN_NAME[id])}
              </button>
            ))}
          </div>
          {(['claude', 'codex'] as const).map((id) => {
            const state = brains.find((b) => b.id === id)
            const connected = state?.installed === true && state.loggedIn
            const carried = state?.installed === true
            return (
              <div key={id} className="settings-fact">
                <span className="settings-fact-key">{t(BRAIN_NAME[id])}</span>
                <span className="settings-fact-value" data-testid={`brain-${id}-status`}>
                  {connecting === id
                    ? t('settings.brainConnecting')
                    : connected
                      ? t('settings.brainConnected')
                      : carried
                        ? t('settings.brainNotConnected')
                        : t('settings.brainMissing')}
                  {carried && !connected && connecting !== id && (
                    <button className="secondary" data-testid={`brain-${id}-connect`} onClick={() => void connect(id)}>
                      {t('settings.brainConnect')}
                    </button>
                  )}
                  {connected && (
                    <button className="secondary" data-testid={`brain-${id}-disconnect`} onClick={() => void disconnect(id)}>
                      {t('settings.brainDisconnect')}
                    </button>
                  )}
                  {connectFail[id] && <span className="settings-fact-sub">{connectFail[id]}</span>}
                </span>
              </div>
            )
          })}
          {/* Which model each brain answers with. Claude names sizes; the
              default follows the app's own spread (mid-size for the work,
              small for chores). ChatGPT takes a model id, or its plan's own
              default when left empty. */}
          <div className="settings-fact">
            <span className="settings-fact-key">{t('settings.modelClaude')}</span>
            <span className="settings-fact-value">
              <select className="settings-input" data-testid="model-claude" value={settings.claudeModel ?? ''} onChange={(e) => patch({ claudeModel: e.target.value })}>
                <option value="">{t('settings.modelAuto')}</option>
                {claudeChoices.map((row) => (
                  <option key={row.value} value={row.value}>
                    {row.label}
                  </option>
                ))}
                {settings.claudeModel && !claudeChoices.some((row) => row.value === settings.claudeModel) && (
                  <option value={settings.claudeModel}>{settings.claudeModel}</option>
                )}
              </select>
            </span>
          </div>
          <div className="settings-fact">
            <span className="settings-fact-key">{t('settings.modelChatGPT')}</span>
            <span className="settings-fact-value">
              <input
                className="settings-input"
                data-testid="model-codex"
                placeholder={t('settings.modelAuto')}
                defaultValue={settings.codexModel ?? ''}
                onBlur={(e) => {
                  const value = e.target.value.trim()
                  if (value !== (settings.codexModel ?? '')) patch({ codexModel: value })
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
            </span>
          </div>
        </div>

        <details className="settings-more" data-testid="settings-more">
          <summary>{t('settings.more')}</summary>
          <div className="settings-group-head">{t('settings.groupConnections')}</div>
          <div className="setting-row column">
            <span>{t('settings.mcpTitle')}</span>
            <div className="setting-hint">{t('settings.mcpHint')}</div>
            <div className="mcp-actions">
              <button className="secondary" data-testid="mcp-reconnect" onClick={() => void reconnectMcp()}>
                {t('settings.mcpReconnect')}
              </button>
              <button className="link-button" onClick={() => void copyMcpConfig()}>
                {t('settings.mcpCopy')}
              </button>
            </div>
            {mcpStatus && <div className="setting-hint" data-testid="mcp-status">{mcpStatus}</div>}
          </div>
          <div className="setting-row column" data-testid="setting-session-watch">
            <span>{t('settings.watchTitle')}</span>
            <div className="setting-hint">{t('settings.watchHint')}</div>
          </div>
          <div className="setting-row column" data-testid="setting-audit">
            <span>{t('settings.auditTitle')}</span>
            <div className="setting-hint">{t('settings.auditHint')}</div>
            <div className="mcp-actions">
              <button className="secondary" data-testid="audit-open" onClick={() => void api.auditOpen().catch(() => undefined)}>
                {t('settings.auditOpen')}
              </button>
            </div>
          </div>
          <div className="setting-row column">
            <span>{t('settings.githubTitle')}</span>
            <div className="setting-hint">{t('settings.githubHint')}</div>
            <div className="mcp-actions">
              <button
                className="secondary"
                data-testid="settings-github-backup"
                onClick={() => {
                  onClose()
                  window.dispatchEvent(new Event('engram:open-github'))
                }}
              >
                {t('settings.githubButton')}
              </button>
            </div>
          </div>
        </details>

        <div className="settings-facts">
          <div className="settings-fact" title={t('settings.semanticHint')}>
            <span className="settings-fact-key">{t('settings.semanticTitle')}</span>
            <span className="settings-fact-value" data-testid="semantic-status">
              {semantic && semantic.status !== 'off' ? (
                <>
                  {
                    {
                      loading: t('settings.semanticLoading'),
                      indexing: t('settings.semanticIndexing'),
                      ready: t('settings.semanticReady'),
                      error: t('settings.semanticError'),
                    }[semantic.status]
                  }
                  {semantic.detail ? ` — ${semantic.detail}` : ''}
                  <span className="settings-fact-sub">{semantic.model}</span>
                </>
              ) : (
                t('settings.semanticIdle')
              )}
            </span>
          </div>
          <div className="settings-fact">
            <span className="settings-fact-key">{t('settings.versionKey')}</span>
            <span className="settings-fact-value" data-testid="settings-version">
              {version ?? '—'}
            </span>
          </div>
          {/* The automatic check runs on a timer the user cannot see, and on an
              unsigned macOS build it can only ever report — so the answer has
              to be askable on demand. */}
          <div className="settings-fact">
            <span className="settings-fact-key">{t('settings.updateKey')}</span>
            <span className="settings-fact-value" data-testid="settings-update">
              {update?.state === 'downloading' ? (
                // The bytes are still arriving: there is nothing to restart
                // into yet, so the button says what is happening instead.
                <>
                  {t('settings.updateDownloading', {
                    version: update.version ?? '',
                    percent: update.percent ?? 0,
                  })}
                  <button
                    className="secondary settings-fact-btn"
                    data-testid="settings-update-refresh"
                    disabled={checkingUpdate}
                    onClick={() => {
                      setCheckingUpdate(true)
                      void api
                        .updateCheck()
                        .then(setUpdate)
                        .catch(() => {})
                        .finally(() => setCheckingUpdate(false))
                    }}
                  >
                    {t('settings.updateCheck')}
                  </button>
                </>
              ) : update?.state === 'ready' || update?.state === 'available' ? (
                <>
                  {t('settings.updateAvailable', { version: update.version ?? '' })}
                  <button
                    className="secondary settings-fact-btn"
                    onClick={() => {
                      void api.updateInstall().then((r) => {
                        // Only reachable if the download finished between the
                        // check and the click going the other way.
                        if (!r.started) void api.updateCheck().then(setUpdate)
                      })
                    }}
                  >
                    {update.selfInstalls ? t('banner.updateRestart') : t('settings.updateGet')}
                  </button>
                </>
              ) : (
                <>
                  {checkingUpdate
                    ? t('settings.updateChecking')
                    : update?.state === 'current'
                      ? t('settings.updateCurrent')
                      : update?.state === 'error'
                        ? t('settings.updateError', { reason: update.message ?? '' })
                        : update?.state === 'checking-unavailable'
                          ? t('settings.updateDev')
                          : ''}
                  <button
                    className="secondary settings-fact-btn"
                    data-testid="settings-update-check"
                    disabled={checkingUpdate}
                    onClick={() => {
                      setCheckingUpdate(true)
                      void api
                        .updateCheck()
                        .then(setUpdate)
                        .catch(() => {})
                        .finally(() => setCheckingUpdate(false))
                    }}
                  >
                    {t('settings.updateCheck')}
                  </button>
                </>
              )}
            </span>
          </div>
        </div>

        {/* Primary action sits rightmost — same order as diagnostics/onboarding. */}
        <div className="dialog-actions">
          <button className="link-button" onClick={() => setShowDiagnostics(true)}>
            {t('settings.diagnostics')}
          </button>
          <button className="link-button" data-testid="settings-feedback" onClick={() => void api.sendFeedback()}>
            {t('settings.feedback')}
          </button>
          <button className="secondary" onClick={onClose}>
            {t('settings.cancel')}
          </button>
          <button className="primary" onClick={() => void save()}>
            {t('settings.save')}
          </button>
        </div>
      </div>
      {showDiagnostics && <DiagnosticsView onClose={() => setShowDiagnostics(false)} />}
    </div>
  )
}
