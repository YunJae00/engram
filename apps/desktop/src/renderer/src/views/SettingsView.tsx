import { useEffect, useRef, useState } from 'react'
import { FolderOpen, CloudUpload, ScrollText, LoaderCircle, Activity, Check } from 'lucide-react'
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
import { WorkMapSettings } from '../components/WorkMapSettings.js'
import { WorkInterviewDialog } from '../components/WorkInterview.js'
import { TaskRecordingSettings } from '../components/TaskRecordingSettings.js'
import { AppearanceSettings } from '../components/AppearanceSettings.js'
import { HelpPanel } from '../components/HelpPanel.js'
import { DeveloperSettings } from '../components/DeveloperSettings.js'
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
  const [showDiagnostics, setShowDiagnostics] = useState(false)
  const [interviewOpen, setInterviewOpen] = useState(false)
  const [semantic, setSemantic] = useState<SemanticStatusDto | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateCheckDto | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(true)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [journalSaving, setJournalSaving] = useState(false)
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setCheckingUpdate(true)
    const loads = [
      api.settingsGet().then((value) => { if (alive) { setSettings(value); setReady(true) } }).catch(() => { if (alive) setReady(true) }),
      api.appVersion().then(setVersion),
      api.activityGet().then(setDeskJournal),
      // Refresh the feed even when an older release is already downloaded.
      api.updateCheck().then(value => { if (alive) setUpdate(value) })
        .catch(() => { if (alive) setUpdate({ state: 'error', message: 'Could not check for updates. Try again.', selfInstalls: false }) })
        .finally(() => { if (alive) setCheckingUpdate(false) }),
      api.semanticStatus().then(setSemantic).catch(() => setSemantic({ status: 'error', detail: 'Could not check status. Retrying…', model: '' })),
    ]
    void Promise.allSettled(loads).then(() => { if (alive) setReady(true) })
    const fallback = setTimeout(() => setReady(true), READY_WAIT_MS)
    const off = api.onEvent((event) => {
      if (event.type === 'settings:changed') setSettings(event.settings)
      if (event.type === 'update:changed') {
        setUpdate(event.update)
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

  // Semantic layer status refreshes while the sheet is open — model
  // download/indexing progress is worth watching live.
  useEffect(() => {
    const timer = setInterval(() => void api.semanticStatus().then(setSemantic).catch(() => {}), 2000)
    return () => clearInterval(timer)
  }, [])

  // Escape closes settings — but yields while the diagnostics overlay is
  // stacked on top (that one handles its own Escape).
  useEscape(onClose, !showDiagnostics && !interviewOpen && !saving)

  if (!settings || !ready)
    return <SettingsLoading failed={ready && !settings} onClose={onClose} onRetry={() => { setReady(false); setAttempt((value) => value + 1) }} />
  const patch = async (change: Partial<AppSettingsDto>) => {
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaved(false)
    setSaveError('')
    const previous = Object.fromEntries(Object.keys(change).map(key => [key, settings[key as keyof AppSettingsDto]]))
    setSettings(value => value && { ...value, ...change })
    try {
      await api.settingsSet(change)
      setSettings(value => value && { ...value, ...change })
      setSaved(true)
    } catch (err) {
      setSettings(value => value && { ...value, ...previous })
      const message = t('toast.settingsFailed', { reason: String((err as Error).message ?? err).slice(0, 120) })
      setSaveError(message)
      showToast(message)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <div className="brief-overlay" onClick={() => { if (!saving) onClose() }}>
      {/* settings-loaded: the skeleton gives way with a short rise instead
          of the rows swapping between two frames. */}
      <div className="brief-box settings-box settings-loaded" onClick={(e) => e.stopPropagation()} data-testid="settings-view" role="dialog" aria-label={t('settings.title')} aria-modal="true">
        <DialogHeader closeLabel="Close settings" disabled={saving} onClose={onClose}>{t('settings.title')}</DialogHeader>

        <div className="settings-body">
        <SettingsNavigation selected={section} onSelect={setSection} />
        <div className="settings-scroll" ref={scroll}>
        <section className="settings-panel" hidden={section !== 'help'} aria-label="Help"><HelpPanel /></section>
        <section className="settings-panel" hidden={section !== 'general'} aria-label="General">
        <h2>General</h2>
        <AppearanceSettings value={settings.theme} disabled={saving} onChange={(theme) => void patch({ theme })} />
        <div className="settings-group">
          <label className="setting-row">
            <span>{t('settings.autoStart')}</span>
            <input
              type="checkbox"
              className="switch"
              data-testid="setting-autostart"
              checked={settings.autoStart}
              disabled={saving}
              onChange={(e) => void patch({ autoStart: e.target.checked })}
            />
          </label>
        </div>
        {section === 'general' && <ComputerSettings />}
        </section>
        <section className="settings-panel" hidden={section !== 'memory'} aria-label="Memory and data">
        <h2>Memory &amp; data</h2>
        <div className="settings-group">
          <label className="setting-row">
            <span className="settings-row-label"><Activity size={18} aria-hidden /><span>App activity<small>App names and window titles only.</small></span></span>
            <input
              type="checkbox"
              className="switch"
              data-testid="setting-desk-journal"
              checked={deskJournal ?? false}
              disabled={deskJournal === null || journalSaving}
              aria-busy={journalSaving}
              onChange={(e) => {
                setJournalSaving(true)
                void api
                  .activitySet(e.target.checked)
                  .then(setDeskJournal)
                  .catch(() => showToast('Could not save app activity. Try again.'))
                  .finally(() => setJournalSaving(false))
              }}
            />
          </label>
        </div>
        {section === 'memory' && <><WorkMapSettings /><TaskRecordingSettings /></>}
        <section aria-label="How you work"><div className="setting-row"><span>How you work</span><button type="button" className="secondary" data-testid="interview-open" onClick={() => setInterviewOpen(true)}>Personalize</button></div></section>
        <details className="settings-disclosure" data-testid="settings-more">
          <summary>Files &amp; backup</summary>
          <div className="setting-row" data-testid="setting-audit">
            <span className="settings-row-label"><ScrollText size={18} aria-hidden /><span>{t('settings.auditTitle')}<small>Local actions and approvals.</small></span></span>
            <button className="secondary" data-testid="audit-open" onClick={() => void api.auditOpen().catch(() => showToast('Could not open the activity log.'))}>
              <FolderOpen size={15} aria-hidden />Open folder
            </button>
          </div>
          <div className="setting-row">
            <span className="settings-row-label"><CloudUpload size={18} aria-hidden /><span>{t('settings.githubTitle')}<small>Private repository.</small></span></span>
              <button
                className="secondary"
                data-testid="settings-github-backup"
                onClick={() => {
                  onClose()
                  window.dispatchEvent(new Event('engram:open-github'))
                }}
              >
                Set up
              </button>
          </div>
        </details>
        </section>
        <section className="settings-panel" hidden={section !== 'ai'} aria-label="AI connection">
        <h2>AI &amp; accounts</h2>
        {section === 'ai' && <EngineSettings />}
        </section>
        <section className="settings-panel" hidden={section !== 'developers'} aria-label="Advanced"><h2>Advanced</h2>{section === 'developers' && <DeveloperSettings />}</section>
        <section className="settings-panel" hidden={section !== 'general'} aria-label="About">
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
          {saveError ? <span className="settings-save-status" role="alert">{saveError}</span> : <span className="settings-save-status" role="status">{saving ? <><LoaderCircle size={14} className="spin" aria-hidden />Saving…</> : saved ? <><Check size={14} aria-hidden />Saved</> : null}</span>}
          <button className="primary" disabled={saving} onClick={onClose}>Done</button>
        </div>
        {interviewOpen && <WorkInterviewDialog onClose={() => setInterviewOpen(false)} />}
      </div>
      {showDiagnostics && <DiagnosticsView onClose={() => setShowDiagnostics(false)} />}
    </div>
  )
}
