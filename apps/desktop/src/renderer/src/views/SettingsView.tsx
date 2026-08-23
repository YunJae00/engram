import { useEffect, useState } from 'react'
import type { AppSettingsDto, LocalModelsStateDto, SemanticStatusDto, UpdateCheckDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import { DiagnosticsView } from './DiagnosticsView.js'

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
  const [localModels, setLocalModels] = useState<LocalModelsStateDto | null>(null)
  const [downloadFail, setDownloadFail] = useState<Record<string, string>>({})
  const [deleteFail, setDeleteFail] = useState<Record<string, string>>({})
  // Delete is two-step and irreversible: the id whose button is armed, and the
  // id whose deletion is in flight. Per-model, so arming one row cannot spill
  // onto the next.
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  // id → percent while a download runs.
  const [progress, setProgress] = useState<Record<string, number>>({})
  const [folders, setFolders] = useState<string[]>([])
  const [browsers, setBrowsers] = useState<{ id: string; name: string; running: boolean }[]>([])
  const [importedAt, setImportedAt] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [searchPaste, setSearchPaste] = useState('')
  const [searchTemplate, setSearchTemplate] = useState('')

  useEffect(() => {
    void api.appVersion().then(setVersion).catch(() => {})
    void api.localModelsState().then(setLocalModels).catch(() => {})
    void api.contentFolders().then(setFolders).catch(() => {})
    void api.browsersList().then(setBrowsers).catch(() => {})
    void api.browserImportedAt().then(setImportedAt).catch(() => {})
    void api.settingsGet().then((current) => setSearchTemplate(current.searchTemplate ?? '')).catch(() => {})
    void api.activityGet().then(setDeskJournal).catch(() => {})
    void api.sessionWatchGet().then(setSessionWatch).catch(() => {})
    // What the updater already knows, shown without a click — a downloaded
    // update used to hide behind Check now.
    void api.updateState().then(setUpdate).catch(() => {})
    return api.onEvent((event) => {
      if (event.type === 'localmodels:changed') setLocalModels(event.state)
      else if (event.type === 'localmodel:progress') {
        setProgress((prior) => ({
          ...prior,
          [event.id]: event.total > 0 ? Math.min(100, Math.round((event.received / event.total) * 100)) : 0,
        }))
      } else if (event.type === 'update:ready') {
        setUpdate({ state: 'ready', version: event.version, selfInstalls: event.selfInstalls })
      }
    })
  }, [])

  // While the download runs, the percent moves — follow it, and catch the
  // flip to ready even if the broadcast landed before this sheet opened.
  useEffect(() => {
    if (update?.state !== 'downloading') return
    const timer = setInterval(() => void api.updateState().then(setUpdate).catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [update?.state])

  // An armed Delete button that stays armed is a mis-click away from a
  // multi-gigabyte re-download, so it disarms itself shortly after the first
  // click. (Clicking elsewhere blurs the button, which disarms it too.)
  useEffect(() => {
    if (!confirmingId) return
    const timer = setTimeout(() => setConfirmingId(null), 4000)
    return () => clearTimeout(timer)
  }, [confirmingId])

  const deleteModel = (id: string) => {
    setConfirmingId(null)
    setDeletingId(id)
    setDeleteFail((prior) => ({ ...prior, [id]: '' }))
    void api
      .localModelDelete(id)
      .then((r) => {
        if (!r.ok) setDeleteFail((prior) => ({ ...prior, [id]: r.reason ?? '' }))
      })
      .catch((err: unknown) => setDeleteFail((prior) => ({ ...prior, [id]: String(err) })))
      .finally(() => setDeletingId((prior) => (prior === id ? null : prior)))
  }

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

  useEffect(() => {
    void api.settingsGet().then(setSettings)
    // Semantic layer status refreshes while the sheet is open — model
    // download/indexing progress is worth watching live.
    void api.semanticStatus().then(setSemantic).catch(() => {})
    const timer = setInterval(() => void api.semanticStatus().then(setSemantic).catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [])

  // Escape closes settings — but yields while the diagnostics overlay is
  // stacked on top (that one handles its own Escape).
  useEscape(onClose, !showDiagnostics)

  if (!settings) return null
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
      <div className="brief-box settings-box" onClick={(e) => e.stopPropagation()} data-testid="settings-view">
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
        {/* The local brain: curated models, download
            what you want, pick one as active. The recommended badge comes
            from a real hardware probe, not a guess. */}
        {/* Consent gate for content capture: nothing
            is read until the user names the folders. */}
        {/* The agent window starts as a stranger to every site the person
            uses. This hands it their own sessions, once, on purpose. */}
        {/* Where the person searches. They paste one results address; the
            shape is read out of it. No engine is named anywhere in the app. */}
        <div className="settings-group-head">{t('settings.searchTitle')}</div>
        <div className="settings-group">
          <div className="setting-note">{t('settings.searchHint')}</div>
          <div className="model-row">
            <input
              className="routine-step-input"
              data-testid="search-template"
              placeholder={t('settings.searchPlaceholder')}
              value={searchPaste}
              onChange={(e) => setSearchPaste(e.target.value)}
            />
            <button
              className="secondary"
              data-testid="search-template-save"
              disabled={searchPaste.trim().length === 0}
              onClick={() =>
                void api.searchTemplateLearn(searchPaste).then((result) => {
                  if (result.ok && result.template) {
                    setSearchTemplate(result.template)
                    setSearchPaste('')
                    showToast(t('settings.searchLearned'))
                  } else showToast(t('settings.searchNotLearned'))
                })
              }
            >
              {t('settings.searchSave')}
            </button>
          </div>
          {searchTemplate !== '' && <div className="setting-note">{searchTemplate}</div>}
        </div>

        <div className="settings-group-head">{t('settings.browserTitle')}</div>
        <div className="settings-group">
          <div className="setting-note">{t('settings.browserHint')}</div>
          {importedAt !== null && (
            <div className="setting-note">{t('settings.browserImported', { when: new Date(importedAt).toLocaleString() })}</div>
          )}
          {browsers.map((browser) => (
            <div key={browser.id} className="model-row">
              <span className="model-desc">
                {browser.name}
                {browser.running ? ` — ${t('settings.browserClose')}` : ''}
              </span>
              <button
                className="secondary"
                disabled={browser.running || importing}
                data-testid={`browser-import-${browser.id}`}
                onClick={() => {
                  setImporting(true)
                  void api
                    .browserImport(browser.id)
                    .then((result) => {
                      showToast(result.ok ? t('settings.browserImportOk') : (result.error ?? t('settings.browserImportFailed')))
                      return api.browserImportedAt().then(setImportedAt)
                    })
                    .catch(() => showToast(t('settings.browserImportFailed')))
                    .finally(() => {
                      setImporting(false)
                      void api.browsersList().then(setBrowsers)
                    })
                }}
              >
                {t('settings.browserImport')}
              </button>
            </div>
          ))}
          {importedAt !== null && (
            <button
              className="secondary"
              onClick={() =>
                void api.browserForget().then(() => {
                  setImportedAt(null)
                  showToast(t('settings.browserForgotten'))
                })
              }
            >
              {t('settings.browserForget')}
            </button>
          )}
        </div>

        <div className="settings-group-head">{t('settings.contentTitle')}</div>
        <div className="settings-group">
          <div className="setting-note">{t('settings.contentHint')}</div>
          {folders.map((folder) => (
            <div key={folder} className="model-row">
              <span className="model-desc" style={{ wordBreak: 'break-all' }}>{folder}</span>
              <button
                className="secondary"
                onClick={() =>
                  void api
                    .contentRemoveFolder(folder)
                    .then(setFolders)
                    .catch(() => void api.contentFolders().then(setFolders))
                }
              >
                {t('settings.contentRemove')}
              </button>
            </div>
          ))}
          <button
            className="secondary"
            onClick={() =>
              void api
                .contentAddFolder()
                .then(setFolders)
                .catch(() => void api.contentFolders().then(setFolders))
            }
          >
            {t('settings.contentAdd')}
          </button>
        </div>

        <div className="settings-group-head">{t('settings.localTitle')}</div>
        <div className="settings-group">
          <div className="setting-note">{t('settings.localHint', { ram: localModels?.ramGB ?? 0 })}</div>
          {(localModels?.models ?? []).map((m) => {
            const pct = progress[m.id]
            return (
              <div key={m.id} className={`model-row model-card${m.active ? ' active' : ''}`} data-testid={`model-${m.id}`}>
                <div className="model-info">
                  <span className="model-name">
                    {m.label}
                    {localModels?.recommendedId === m.id && (
                      <span className="model-badge">{t('settings.localRecommended')}</span>
                    )}
                  </span>
                  <span className="model-desc">{m.desc}</span>
                  <span className="model-meta">
                    {m.approxGB}GB · RAM {m.ramGB}GB+
                  </span>
                </div>
                <span className="model-actions">
                  {m.downloading ? (
                    <>
                      <span className="model-progress">{pct !== undefined ? `${pct}%` : '…'}</span>
                      <button className="secondary" onClick={() => void api.localModelCancel(m.id)}>
                        {t('settings.localCancel')}
                      </button>
                    </>
                  ) : m.downloaded ? (
                    <>
                      {m.active ? (
                        <span className="model-chip-inuse">{t('settings.localInUse')}</span>
                      ) : (
                        <button
                          className="secondary"
                          data-testid={`model-use-${m.id}`}
                          onClick={() =>
                            void api
                              .localModelSetActive(m.id)
                              .catch(() => undefined)
                              .finally(() => void api.localModelsState().then(setLocalModels))
                          }
                        >
                          {t('settings.localUse')}
                        </button>
                      )}
                      {/* First click arms, second click deletes. Never offered
                          while the model downloads — Cancel is that action. */}
                      <button
                        className={confirmingId === m.id ? 'secondary model-delete-armed' : 'secondary'}
                        data-testid={`model-delete-${m.id}`}
                        disabled={deletingId === m.id}
                        onBlur={() => setConfirmingId((prior) => (prior === m.id ? null : prior))}
                        onClick={() => (confirmingId === m.id ? deleteModel(m.id) : setConfirmingId(m.id))}
                      >
                        {deletingId === m.id
                          ? t('settings.localDeleting')
                          : confirmingId === m.id
                            ? t('settings.localDeleteConfirm')
                            : t('settings.localDelete')}
                      </button>
                    </>
                  ) : (
                    <button
                      className="secondary"
                      onClick={() => {
                        setDownloadFail((prev) => ({ ...prev, [m.id]: '' }))
                        void api.localModelDownload(m.id).then((r) => {
                          if (!r.ok && r.log !== 'canceled')
                            setDownloadFail((prev) => ({ ...prev, [m.id]: r.log ?? '' }))
                        })
                      }}
                    >
                      {t('settings.localDownload')}
                    </button>
                  )}
                </span>
                {downloadFail[m.id] && (
                  <span className="model-fail">{t('settings.localFailed', { reason: downloadFail[m.id]! })}</span>
                )}
                {deleteFail[m.id] && (
                  <span className="model-fail" data-testid={`model-delete-fail-${m.id}`}>
                    {t('settings.localDeleteFailed', { reason: deleteFail[m.id]! })}
                  </span>
                )}
              </div>
            )
          })}
        </div>

        <div className="settings-group-head">{t('settings.groupConnections')}</div>

        <div className="setting-row column">
          <span>{t('settings.mcpTitle')}</span>
          <div className="setting-hint">{t('settings.mcpHint')}</div>
          {/* One button, not three. The app already connects both clients on
              launch, so asking the user to pick which one to fix was making
              them do the app's bookkeeping. Copy JSON stays as a quiet escape
              hatch — it is the only route for a non-Claude MCP client. */}
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

        {/* No switch: the app being open is the switch. But a deal only works
            if the other side knows what it is, and this one reads conversations
            from every project on the machine and spends the user's own Claude
            quota — which until now was documented in a source comment and
            nowhere a user could see. */}
        <div className="setting-row column" data-testid="setting-session-watch">
          <span>{t('settings.watchTitle')}</span>
          <div className="setting-hint">{t('settings.watchHint')}</div>
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
          <button className="secondary" data-testid="settings-feedback" onClick={() => void api.sendFeedback()}>
            {t('settings.feedback')}
          </button>
          <button className="secondary" onClick={() => setShowDiagnostics(true)}>
            {t('settings.diagnostics')}
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
