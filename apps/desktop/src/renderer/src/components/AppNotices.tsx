import { Bell, Download, LoaderCircle, PlugZap, X } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import type { AppSettingsDto, UpdateCheckDto } from '../../../shared/types.js'
import { api } from '../api.js'
import { t } from '../i18n.js'
import { useApp, type AppState } from '../state.js'

interface AppNoticesProps {
  showAiNotices?: boolean
  engines: AppState['engines']
  enginesDetected: boolean
  pendingWork: AppState['pendingWork']
  update: UpdateCheckDto | null
  vaultReady: boolean
  onOpenSettings: () => void
}

export const AppNotices = memo(function AppNotices({
  showAiNotices = true,
  engines,
  enginesDetected,
  pendingWork,
  update,
  vaultReady,
  onOpenSettings,
}: AppNoticesProps) {
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState(false)
  const [filingProvider, setFilingProvider] = useState<string | null>(null)
  useEffect(() => {
    let alive = true, changed = false
    const read = (settings: AppSettingsDto) => {
      if (alive) setFilingProvider((settings.aiSelections?.filing?.engine ?? settings.defaultEngine) === 'codex' ? 'ChatGPT' : 'Claude')
    }
    void api.settingsGet().then(settings => { if (!changed) read(settings) }).catch(() => undefined)
    const off = api.onEvent(event => { if (event.type === 'settings:changed') { changed = true; read(event.settings) } })
    return () => { alive = false; off() }
  }, [])
  useEffect(() => setError(false), [update?.version, update?.state])
  // A provider failing on its side is said where it failed, in the conversation;
  // the background work waits it out on its own.
  const unhealthy = engines.filter((engine) => engine.healthy === false && engine.healthReason !== 'outage')
  const unhealthyIds = unhealthy.map((engine) => engine.id === 'codex' ? 'ChatGPT' : engine.id === 'claude' ? 'Claude' : engine.id).join(', ')
  const reason = unhealthy[0]?.healthReason
  const unhealthyText =
    reason === 'auth'
      ? t('banner.loginExpired', { ids: unhealthyIds })
      : reason === 'quota'
        ? t('banner.quota', { ids: unhealthyIds })
        : reason === 'network'
          ? t('banner.offline', { ids: unhealthyIds })
          : t('banner.notResponding', { ids: unhealthyIds })
  const waiting = pendingWork.inbox + pendingWork.notes

  return (
    <div className="notices">
      {showAiNotices && vaultReady && enginesDetected && engines.length === 0 && (
        <div className="connect-banner" data-testid="connect-banner">
          <PlugZap size={14} strokeWidth={1.8} aria-hidden />
          <span>
            {filingProvider ? `${filingProvider} is selected for filing but isn't ready. Check its connection or choose another AI in Settings.` : t('banner.noBrain')}
            {waiting > 0 && ` · ${t('banner.waiting', { n: waiting })}`}
          </span>
          <button className="connect-banner-btn" onClick={onOpenSettings}>
            {t('banner.getBrain')}
          </button>
        </div>
      )}
      {showAiNotices && unhealthy.length > 0 && (
        <div className="connect-banner" data-testid="unhealthy-banner">
          <PlugZap size={14} strokeWidth={1.8} aria-hidden />
          <span>{unhealthyText}</span>
          <button
            className="connect-banner-btn"
            onClick={() => reason === 'auth' || reason === 'quota' ? onOpenSettings() : window.dispatchEvent(new Event('engram:open-diagnostics'))}
          >
            {reason === 'auth' ? t('banner.login') : t('banner.check')}
          </button>
        </div>
      )}
      {update?.version && !['current', 'checking-unavailable'].includes(update.state) && (
        <div className="connect-banner update-banner" data-testid="update-banner">
          <Download size={14} strokeWidth={1.8} aria-hidden />
          <span>
            {error ? t('settings.updateError', { reason: 'Could not check for updates. Try again.' })
              : update.state === 'downloading' ? t('settings.updateDownloading', { version: update.version, percent: update.percent ?? 0 })
              : update.state === 'error' ? t('settings.updateError', { reason: update.message ?? '' })
              : update.state === 'ready' ? t('banner.updateReady', { version: update.version })
              : t('banner.updateAvailable', { version: update.version })}
          </span>
          <button className="connect-banner-btn" disabled={checking || update.state === 'downloading'} onClick={() => {
            setChecking(true); setError(false)
            void (update.state === 'error' ? api.updateCheck().then(result => { setError(result.state === 'error') })
              : api.updateInstall().then(result => { setError(!result.started && result.reason !== 'downloading') }))
              .catch(() => setError(true)).finally(() => setChecking(false))
          }}>
            {checking || update.state === 'downloading' ? <LoaderCircle size={14} className="spin" aria-label="Checking update" />
              : update.state === 'error' || error ? t('settings.updateCheck')
              : update.selfInstalls ? t('banner.updateRestart') : t('banner.updateDownload')}
          </button>
        </div>
      )}
    </div>
  )
})

const TOAST_MS = 6000, TOAST_EXIT_MS = 120

export function useToastDismiss(): () => void {
  return useApp().hideToast
}

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef<() => void>(() => undefined)
  const [leaving, setLeaving] = useState(false)
  // A toast that appears under a still pointer pauses on the first pointer move: the click-through surface cannot report :hover.
  useEffect(() => {
    let remaining = TOAST_MS, started = performance.now(), hovered = false, done = false
    let timer: number | undefined = window.setTimeout(() => finish(), remaining), exit: number | undefined
    const finish = () => {
      if (done) return
      done = true
      window.clearTimeout(timer)
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return onDone()
      setLeaving(true)
      exit = window.setTimeout(onDone, TOAST_EXIT_MS)
    }
    const hover = (inside: boolean) => {
      if (done || inside === hovered) return
      hovered = inside
      if (inside) {
        window.clearTimeout(timer)
        remaining -= performance.now() - started
      } else {
        started = performance.now()
        timer = window.setTimeout(finish, remaining)
      }
    }
    // The toast is click-through, so it never receives pointerenter itself.
    const move = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect()
      hover(!!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)
    }
    const out = (e: PointerEvent) => { if (e.relatedTarget === null) hover(false) }
    close.current = finish
    window.addEventListener('pointermove', move)
    document.addEventListener('pointerout', out)
    return () => {
      window.clearTimeout(timer)
      window.clearTimeout(exit)
      window.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', out)
    }
  }, [onDone])
  return (
    <div ref={ref} className={leaving ? 'toast toast-leaving' : 'toast'} role="status">
      <span className="toast-icon" aria-hidden="true"><Bell size={16} aria-hidden /></span>
      <strong className="toast-title">{message}</strong>
      <button type="button" className="toast-close" aria-label={t('topbar.close')} onClick={() => close.current()}><X size={14} aria-hidden /></button>
    </div>
  )
}
