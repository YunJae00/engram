import { useEffect, useRef, useState } from 'react'
import type { AppSettingsDto, SemanticStatusDto, UpdateCheckDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import { DiagnosticsView } from './DiagnosticsView.js'
import { EngineSettings } from '../components/EngineSettings.js'
import { SettingsStatus } from '../components/SettingsStatus.js'
import { DialogHeader } from '../components/DialogHeader.js'
import { SettingsLoading } from '../components/SettingsLoading.js'
import { ComputerSettings } from '../components/ComputerSettings.js'
import { AppearanceSettings } from '../components/AppearanceSettings.js'
import { HelpPanel } from '../components/HelpPanel.js'
import { SettingsNavigation, type SettingsSection } from '../components/SettingsNavigation.js'

// Only local settings gate the sheet. Network and runtime probes fill their
// own sections without blocking navigation.
const READY_WAIT_MS = 8_000

export function SettingsView({ onClose, initialSection = 'general' }: { onClose(): void; initialSection?: SettingsSection }) {
  const { showToast, t } = useApp()
  const [section, setSection] = useState<SettingsSection>(initialSection)
  useEffect(() => setSection(initialSection), [initialSection])
  const scroll = useRef<HTMLDivElement>(null)
  useEffect(() => { if (scroll.current) scroll.current.scrollTop = 0 }, [section])
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [deskJournal, setDeskJournal] = useState<boolean | null>(null)
  const [sessionWatch, setSessionWatch] = useState<boolean | null>(null)
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [mcpStatus, setMcpStatus] = useState<string | null>(null)
  const [semantic, setSemantic] = useState<SemanticStatusDto | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateCheckDto | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(false)
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    const loads = [
      api.settingsGet().then((value) => { if (alive) { setSettings(value); setReady(true) } }).catch(() => { if (alive) setReady(true) }),
      api.appVersion().then(setVersion),
      api.activityGet().then(setDeskJournal),
      api.sessionWatchGet().then(setSessionWatch),
      // What the updater already knows, shown without a click — a downloaded
      // update used to hide behind Check now.
      api.updateState().then(setUpdate),
      api.semanticStatus().then(setSemantic),
    ]
    void Promise.allSettled(loads).then(() => { if (alive) setReady(true) })
    const fallback = setTimeout(() => setReady(true), READY_WAIT_MS)
    const off = api.onEvent((event) => {
      if (event.type === 'settings:changed') setSettings((current) => current ? { ...current, computerUse: event.settings.computerUse } : event.settings)
      if (event.type === 'update:ready') {
        setUpdate({ state: 'ready', version: event.version, selfInstalls: event.selfInstalls })
      }
    })
    return () => {
      alive = false
      clearTimeout(fallback)
      off()
    }
  }, [attempt])

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
      await api.copyText(info.configJson)
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
    return <SettingsLoading failed={ready && !settings} onClose={onClose} onRetry={() => { setReady(false); setAttempt((value) => value + 1) }} />
  const patch = (p: Partial<AppSettingsDto>) => setSettings((current) => current ? { ...current, ...p } : current)

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
      <div className="brief-box settings-box settings-loaded" onClick={(e) => e.stopPropagation()} data-testid="settings-view" role="dialog" aria-label={t('settings.title')} aria-modal="true">
        <DialogHeader closeLabel={t('settings.cancel')} onClose={onClose}>{t('settings.title')}</DialogHeader>

        <div className="settings-body">
        <SettingsNavigation selected={section} onSelect={setSection} />
        <div className="settings-scroll" ref={scroll}>
        <section className="settings-panel" hidden={section !== 'help'} aria-label="Help"><HelpPanel /></section>
        <section className="settings-panel" hidden={section !== 'general'} aria-label="General">
        <h2>General</h2>
        <p className="setting-hint">Make Engram feel at home.</p>
        <AppearanceSettings value={settings.theme} onChange={(theme) => patch({ theme })} />
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
        </div>
        </section>
        <section className="settings-panel" hidden={section !== 'computer'} aria-label="Computer use">
        <h2>Computer use</h2>
        <ComputerSettings />
        </section>
        <section className="settings-panel" hidden={section !== 'memory'} aria-label="Memory and data">
        <h2>Memory &amp; data</h2>
        <p className="setting-hint">Choose what Engram remembers.</p>
        <div className="settings-group">
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
        <details className="setting-hint"><summary>What gets remembered</summary><p>App activity records foreground app and window titles. Coding sessions are collected from connected coding tools for your memory.</p></details>
        </section>
        <section className="settings-panel" hidden={section !== 'ai'} aria-label="AI connection">
        <h2>AI connection</h2>
        {section === 'ai' && <EngineSettings settings={settings} onChange={patch} />}
        </section>
        <section className="settings-panel" hidden={section !== 'memory'} aria-label="Data connections">
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
          <div className="setting-row column">
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
        </section>
        <section className="settings-panel" hidden={section !== 'about'} aria-label="About">
        <h2>About Engram</h2>
        <div className="settings-app-section">
          <div className="settings-support-actions">
            <button className="secondary" onClick={() => setShowDiagnostics(true)}>
              {t('settings.diagnostics')}
            </button>
            <button className="secondary" data-testid="settings-feedback" onClick={() => void api.sendFeedback()}>
              {t('settings.feedback')}
            </button>
          </div>
          <SettingsStatus
          checkingUpdate={checkingUpdate}
          semantic={semantic}
          update={update}
          version={version}
          onCheckingUpdate={setCheckingUpdate}
          onUpdate={setUpdate}
          />
        </div>
        </section>
        </div>
        </div>

        <div className="dialog-actions">
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
