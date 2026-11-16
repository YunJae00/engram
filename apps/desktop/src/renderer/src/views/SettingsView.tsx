import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { AppSettingsDto, UpdateCheckDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { useEscape } from '../lib/useEscape.js'
import { useApp } from '../state.js'
import { EngineSettings } from '../components/EngineSettings.js'
import { SettingsStatus } from '../components/SettingsStatus.js'
import { DialogHeader } from '../components/DialogHeader.js'
import { SettingsLoading } from '../components/SettingsLoading.js'
import { AppearanceSettings } from '../components/AppearanceSettings.js'
import { Keys, SettingsGroup, SettingsItem } from '../components/SettingsLayout.js'
import { MOD_LABEL } from '../i18n.js'
import { DeveloperSettings } from '../components/DeveloperSettings.js'
import { ResetSettings } from '../components/ResetSettings.js'

// Only local settings gate the sheet. Network and runtime probes fill their
// own rows without blocking it.
const READY_WAIT_MS = 8_000

// One page, five things: theme, the shortcut, the AI account, start fresh, and the version.
// Everything else is asked for in chat (main/preferences-chat.ts).
export function SettingsView({ onClose }: { onClose(): void }) {
  const { showToast, t } = useApp()
  const [settings, setSettings] = useState<AppSettingsDto | null>(null)
  const [version, setVersion] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateCheckDto | null>(null)
  const [checkingUpdate, setCheckingUpdate] = useState(true)
  const [ready, setReady] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    setCheckingUpdate(true)
    const loads = [
      api.settingsGet().then((value) => { if (alive) { setSettings(value); setReady(true) } }).catch(() => { if (alive) setReady(true) }),
      api.appVersion().then(setVersion),
      // Refresh the feed even when an older release is already downloaded.
      api.updateCheck().then(value => { if (alive) setUpdate(value) })
        .catch(() => { if (alive) setUpdate({ state: 'error', message: t('settingsUi.updateCheckFailed'), selfInstalls: false }) })
        .finally(() => { if (alive) setCheckingUpdate(false) }),
    ]
    void Promise.allSettled(loads).then(() => { if (alive) setReady(true) })
    const fallback = setTimeout(() => setReady(true), READY_WAIT_MS)
    const off = api.onEvent((event) => {
      if (event.type === 'settings:changed') setSettings(event.settings)
      if (event.type === 'update:changed') setUpdate(event.update)
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

  useEscape(onClose)

  if (!settings || !ready)
    return <SettingsLoading failed={ready && !settings} onClose={onClose} onRetry={() => { setReady(false); setAttempt((value) => value + 1) }} />
  const setTheme = (theme: NonNullable<AppSettingsDto['theme']>) => {
    const previous = settings.theme
    setSettings(value => value && { ...value, theme })
    void api.settingsSet({ theme }).catch((err: unknown) => {
      setSettings(value => value && { ...value, theme: previous })
      showToast(t('toast.settingsFailed', { reason: String((err as Error).message ?? err).slice(0, 120) }))
    })
  }

  return (
    <div className="brief-overlay settings-overlay" onClick={onClose}>
      {/* settings-loaded: the skeleton gives way with a short rise instead
          of the rows swapping between two frames. */}
      <div className="brief-box settings-box settings-loaded" onClick={(e) => e.stopPropagation()} data-testid="settings-view" role="dialog" aria-label={t('settings.title')} aria-modal="true">
        <DialogHeader closeLabel={t('settingsUi.close')} onClose={onClose}>{t('settings.title')}</DialogHeader>
        <div className="settings-body"><div className="settings-scroll"><section className="settings-panel" aria-label={t('settings.title')}>
          <SettingsGroup title={t('settingsUi.appearance')} testId="settings-theme"><div className="settings-item"><AppearanceSettings value={settings.theme} onChange={setTheme} /></div></SettingsGroup>
          <SettingsGroup testId="settings-shortcut">
            <SettingsItem icon={<Sparkles size={18} />} title={t('settingsUi.newComet')} description={t('settingsUi.newCometHint')}><Keys keys={[MOD_LABEL, 'Shift', t('settingsUi.keySpace')]} /></SettingsItem>
          </SettingsGroup>
          <EngineSettings />
          <SettingsGroup testId="settings-start-fresh"><ResetSettings /></SettingsGroup>
          <SettingsGroup title="Engram" testId="settings-about">
            <SettingsStatus checkingUpdate={checkingUpdate} update={update} version={version} onCheckingUpdate={setCheckingUpdate} onUpdate={setUpdate} />
          </SettingsGroup>
          {api.developerUiEnabled && <section className="settings-section" aria-label={t('settingsUi.advanced')} data-testid="settings-developers"><h3 className="settings-section-title">{t('settingsUi.advanced')}</h3><DeveloperSettings /></section>}
        </section></div></div>
      </div>
    </div>
  )
}
