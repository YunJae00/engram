import { Download, PlugZap } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { AbsorbWidget } from './components/AbsorbWidget.js'
import { DigestSheet } from './components/DigestSheet.js'
import { HelpPanel } from './components/HelpPanel.js'
import { CosmosChat } from './components/CosmosChat.js'
import { Palette, type PaletteAction, type PaletteMode } from './components/Palette.js'
import { TopBar } from './components/TopBar.js'
import { TourOverlay, TOUR_DONE_KEY } from './components/TourOverlay.js'
import { ActionDialog } from './components/ActionDialog.js'
import { ErrandsSheet } from './components/ErrandsSheet.js'
import { RoutinesSheet } from './components/RoutinesSheet.js'
import { BotsView } from './views/BotsView.js'
import { GithubConnect } from './components/GithubConnect.js'
import { AppProvider, useApp } from './state.js'
import { BubbleView } from './views/BubbleView.js'
import { DiagnosticsView } from './views/DiagnosticsView.js'
import { InboxOverlay } from './views/InboxOverlay.js'
import { ListView } from './views/ListView.js'
import { NoteSheet } from './views/NoteSheet.js'
import { Onboarding } from './views/Onboarding.js'
import { QuickCapture } from './views/QuickCapture.js'
import { ReviewOverlay } from './views/ReviewOverlay.js'
import { SettingsView } from './views/SettingsView.js'
import { SkyView } from './views/SkyView.js'

function Shell() {
  const { activity, setActivity, engines, pendingWork, toast, showToast, refresh, vaultReady, vaultError, t, enginesDetected, openNote } = useApp()
  const [palette, setPalette] = useState<PaletteMode>(null)
  const [dropping, setDropping] = useState(false)
  // Drag tracking: a dragenter/dragleave depth counter (enter and leave fire per
  // child crossed, so a boolean flickers). The overlay clears on drop, window
  // dragend, Escape, and a watchdog if dragover goes quiet — so a drag cancelled
  // outside the window can never leave the scrim stuck over the app.
  const dragDepth = useRef(0)
  const lastOverRef = useRef(0)
  // What the panel should open with — a question to send outright, or a
  // scaffold to write into. Held here because the panel is unmounted while it
  // rests: a window event fired at a closed panel has nobody listening.
  const [action, setAction] = useState<PaletteAction | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [diagOpen, setDiagOpen] = useState(false)
  // "Back up to GitHub" — reachable from the workspace switcher, settings, and
  // the command palette; they all raise this one window intent.
  const [githubOpen, setGithubOpen] = useState(false)
  // The weekly digest reads on demand from the command palette — it is not
  // part of the morning, so it is not mounted with Today.
  const [digestOpen, setDigestOpen] = useState(false)
  // "Delegate an errand…" from the command palette raises this one window intent.
  const [errandOpen, setErrandOpen] = useState(false)
  // `teach` means the sheet should open already recording — the answer to
  // "show me how" is the agent window, not another button to find.
  const [routinesOpen, setRoutinesOpen] = useState<{ teach: boolean } | null>(null)
  // "View in the cosmos" hands over the topic's member ids; the sky consumes
  // them on mount (same seed idiom as chatSeed) and spotlights those stars.
  const [skyFocus, setSkyFocus] = useState<{ ids: string[] } | null>(null)
  // Version of a downloaded update waiting to be applied.
  const [updateReady, setUpdateReady] = useState<string | null>(null)
  const [updateSelfInstalls, setUpdateSelfInstalls] = useState(true)
  useEffect(() => {
    return api.onEvent((e) => {
      // A toast was not enough: closing the window only hides to the tray, so
      // "installs on next quit" never happened and the update sat downloaded
      // forever. This stays on screen with a button that actually applies it.
      if (e.type === 'update:ready') {
        setUpdateReady(e.version)
        setUpdateSelfInstalls(e.selfInstalls)
      }
      // A citation clicked in the floating bubble: the main process already
      // surfaced this window; land on the note itself.
      else if (e.type === 'note:open') openNote(e.id)
      else if (e.type === 'brain:setup') setSettingsOpen(true)
    })
  }, [showToast, t, openNote])

  // Present but not usable. Read off the engine list (which carries the live
  // health verdict and survives a renderer reload) rather than a local state
  // fed only by live events — the onboarding→shell handoff reloads by design,
  // and that used to discard the boot ping's verdict exactly when it mattered.
  const unhealthy = engines.filter((engine) => engine.healthy === false)
  const unhealthyIds = unhealthy.map((engine) => engine.id).join(', ')
  const reason = unhealthy[0]?.healthReason
  const unhealthyText =
    reason === 'auth'
      ? t('banner.loginExpired', { ids: unhealthyIds })
      : reason === 'quota'
        ? t('banner.quota', { ids: unhealthyIds })
        : reason === 'network'
          ? t('banner.offline', { ids: unhealthyIds })
          : t('banner.notResponding', { ids: unhealthyIds })

  // First-run coach marks: once, after the first vault opens, real installs
  // only (the main process gates it so e2e clicks are never intercepted).
  const [tourOpen, setTourOpen] = useState(false)
  useEffect(() => {
    if (!vaultReady || localStorage.getItem(TOUR_DONE_KEY)) return
    let cancelled = false
    void api.tourEligible().then((ok) => {
      if (!ok || cancelled) return
      // let the shell settle so every anchor exists and has its real position
      window.setTimeout(() => {
        if (!cancelled) setTourOpen(true)
      }, 900)
    })
    return () => {
      cancelled = true
    }
  }, [vaultReady])

  // useLayoutEffect, not useEffect: the shell paints (and advertises Cmd+L on
  // a button title) before passive effects commit, so a keypress in that gap
  // would be silently dropped. Layout effects attach before the first paint.
  useLayoutEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'p' && e.shiftKey) {
        e.preventDefault()
        setPalette('commands')
      } else if (key === 'p' || (key === 'f' && e.shiftKey)) {
        e.preventDefault()
        setPalette('search')
      } else if (key === 'l') {
        e.preventDefault()
        setActivity('bots')
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Cross-component intents from the help panel (and future affordances) arrive
  // as window events so leaf components can drive the shell without prop drilling.
  useEffect(() => {
    const toggleChat = () => setActivity('bots')
    const openPalette = () => setPalette('search')
    const openDiag = () => setDiagOpen(true)
    const openImport = () => setAction('import')
    const openGithub = () => setGithubOpen(true)
    const openDigest = () => setDigestOpen(true)
    const openErrand = () => setErrandOpen(true)
    const openRoutines = (event: Event) =>
      setRoutinesOpen({ teach: (event as CustomEvent<{ teach?: boolean }>).detail?.teach === true })
    // The help panel's Remember action and the
    // empty-sky starter chips (which carry a scaffold like "Decided today: ").
    const focusCapture = () => {
      // The dock itself reads the seed off this same event; the shell only
      // makes sure the cosmos (where the dock lives) is on screen.
      setActivity('sky')
    }
    const focusSky = (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids
      if (ids && ids.length > 0) setSkyFocus({ ids })
    }
    window.addEventListener('engram:toggle-chat', toggleChat)
    window.addEventListener('engram:open-palette', openPalette)
    const openBrainSetup = () => setSettingsOpen(true)
    window.addEventListener('engram:open-brain-setup', openBrainSetup)
    window.addEventListener('engram:open-diagnostics', openDiag)
    window.addEventListener('engram:open-import', openImport)
    window.addEventListener('engram:open-github', openGithub)
    window.addEventListener('engram:open-digest', openDigest)
    window.addEventListener('engram:open-errand', openErrand)
    window.addEventListener('engram:open-routines', openRoutines)
    window.addEventListener('engram:focus-capture', focusCapture)
    window.addEventListener('engram:sky-focus', focusSky)
    return () => {
      window.removeEventListener('engram:toggle-chat', toggleChat)
      window.removeEventListener('engram:open-palette', openPalette)
      window.removeEventListener('engram:open-brain-setup', openBrainSetup)
      window.removeEventListener('engram:open-diagnostics', openDiag)
      window.removeEventListener('engram:open-import', openImport)
      window.removeEventListener('engram:open-github', openGithub)
      window.removeEventListener('engram:open-digest', openDigest)
      window.removeEventListener('engram:open-errand', openErrand)
      window.removeEventListener('engram:open-routines', openRoutines)
      window.removeEventListener('engram:focus-capture', focusCapture)
      window.removeEventListener('engram:sky-focus', focusSky)
    }
  }, [])

  // Escape hatches for a drag that never drops on us (cancelled outside the
  // window, dropped elsewhere, or the source vanished). Listeners live only
  // while the overlay is up. The watchdog hides it if no dragover was seen for
  // 1200ms — the browser stops firing dragover once the pointer leaves.
  useEffect(() => {
    if (!dropping) return
    const clear = () => {
      dragDepth.current = 0
      setDropping(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('dragend', clear)
    window.addEventListener('keydown', onKey)
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastOverRef.current > 1200) clear()
    }, 400)
    return () => {
      window.removeEventListener('dragend', clear)
      window.removeEventListener('keydown', onKey)
      window.clearInterval(watchdog)
    }
  }, [dropping])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDropping(false)
    // Per-file try/catch: one unreadable file must not abort the rest of the
    // batch. Partial failure counts what landed and says what did not.
    let captured = 0
    let failed = 0
    for (const file of Array.from(e.dataTransfer.files)) {
      const path = api.pathForFile(file)
      if (!path) continue
      try {
        await api.captureFile(path)
        captured++
      } catch {
        failed++
      }
    }
    const text = e.dataTransfer.getData('text/plain')
    if (text.trim()) {
      try {
        await api.capture(text.trim())
        captured++
      } catch {
        failed++
      }
    }
    if (captured > 0 || failed > 0) {
      showToast(
        failed > 0
          ? `Captured ${captured} item${captured === 1 ? '' : 's'} — ${failed} failed to save`
          : `Captured ${captured} item${captured > 1 ? 's' : ''}`,
      )
      if (captured > 0) await refresh()
    }
  }

  return (
    <div
      className="shell"
      data-testid="shell"
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        lastOverRef.current = Date.now()
        setDropping(true)
      }}
      onDragOver={(e) => {
        e.preventDefault() // required so the drop event fires
        lastOverRef.current = Date.now()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDropping(false)
      }}
      onDrop={(e) => void onDrop(e)}
    >
      <TopBar
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPalette={() => setPalette('search')}
      />
      {/* Notices sit in the flow between the bar and the canvas: a pill
          that pushes the page down rather than floating over its header. */}
      <div className="notices">
        {vaultReady && enginesDetected && engines.length === 0 && (
        <div className="connect-banner" data-testid="connect-banner">
          <PlugZap size={14} strokeWidth={1.8} aria-hidden />
          <span>
            {t('banner.noBrain')}
            {pendingWork.inbox + pendingWork.notes > 0 && ` · ${t('banner.waiting', { n: pendingWork.inbox + pendingWork.notes })}`}
          </span>
          <button className="connect-banner-btn" onClick={() => setSettingsOpen(true)}>
            {t('banner.getBrain')}
          </button>
        </div>
      )}
      {/* Connected on paper, silent in practice: the engine is logged in but
          the boot ping got nothing back (expired token, no network, quota).
          Saying nothing here is what made this read as "it keeps
          disconnecting" — the app looked fine while every call failed. */}
      {unhealthy.length > 0 && (
        <div className="connect-banner" data-testid="unhealthy-banner">
          <PlugZap size={14} strokeWidth={1.8} aria-hidden />
          <span>{unhealthyText}</span>
          {/* Every warning gets an action that actually resolves it: for an
              expired login that is the login terminal, which Diagnostics now
              offers because it reads this same health verdict. */}
          <button className="connect-banner-btn" onClick={() => window.dispatchEvent(new Event('engram:open-diagnostics'))}>
            {reason === 'auth' ? t('banner.login') : t('banner.check')}
          </button>
        </div>
      )}
      {updateReady && (
        <div
          className="connect-banner update-banner"
          data-testid="update-banner"
        >
          <Download size={14} strokeWidth={1.8} aria-hidden />
          <span>
            {updateSelfInstalls
              ? t('banner.updateReady', { version: updateReady })
              : t('banner.updateAvailable', { version: updateReady })}
          </span>
          <button className="connect-banner-btn" onClick={() => void api.updateInstall()}>
            {updateSelfInstalls ? t('banner.updateRestart') : t('banner.updateDownload')}
          </button>
        </div>
      )}
      </div>
      <div className="canvas">
        {/* While a big vault is still being read the views would all claim
            "nothing here" — show the opening state until vault:ready. */}
        {vaultError ? (
          // A dead end must look like one. This state used to be an endless
          // "Opening your vault…" with the reason only in a console nobody
          // reads, which is indistinguishable from a slow disk.
          <div className="empty-view vault-failed" data-testid="vault-failed">
            <strong>{t('shell.failedTitle')}</strong>
            <p>{t('shell.failedBody')}</p>
            <code className="vault-failed-path">{vaultError.root}</code>
            <code className="vault-failed-why">{vaultError.message}</code>
            <div className="vault-failed-actions">
              <button onClick={() => void window.engram.revealVaultRoot(vaultError.root)}>
                {t('shell.failedReveal')}
              </button>
              <button onClick={() => void window.engram.relaunch()}>{t('shell.failedRetry')}</button>
            </div>
          </div>
        ) : !vaultReady ? (
          <div className="empty-view vault-opening" data-testid="vault-opening">{t('shell.opening')}</div>
        ) : activity === 'bots' ? (
          <BotsView />
        ) : activity === 'sky' ? (
          <SkyView focus={skyFocus} onFocusConsumed={() => setSkyFocus(null)} />
        ) : (
          <ListView />
        )}
        {/* The launcher IS the panel at rest — never both on screen at once. */}
        {activity === 'sky' && <CosmosChat />}
        {/* Hung from the top bar now, so it is available wherever the bar is. */}
        <HelpPanel />
      </div>
      <AbsorbWidget />

      <NoteSheet />
      {digestOpen && <DigestSheet onClose={() => setDigestOpen(false)} />}
      {errandOpen && <ErrandsSheet onClose={() => setErrandOpen(false)} />}
      {routinesOpen && <RoutinesSheet startTeaching={routinesOpen.teach} onClose={() => setRoutinesOpen(null)} />}
      <ReviewOverlay />
      <InboxOverlay />
      <Palette mode={palette} onClose={() => setPalette(null)} onAction={setAction} />
      <ActionDialog action={action} onClose={() => setAction(null)} />
      {githubOpen && <GithubConnect onClose={() => setGithubOpen(false)} />}
      {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
      {diagOpen && <DiagnosticsView onClose={() => setDiagOpen(false)} />}
      {tourOpen && <TourOverlay onClose={() => setTourOpen(false)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {dropping && (
        <div className="drop-overlay" data-testid="drop-overlay">
          <div className="drop-frame">
            <div className="drop-title">{t('capture.dropTitle')}</div>
            <div className="drop-sub">{t('capture.dropSub')}</div>
          </div>
        </div>
      )}
    </div>
  )
}

export function App() {
  // The quick-capture and onboarding windows load the same bundle with a hash route.
  if (window.location.hash === '#quick') return <QuickCapture />
  if (window.location.hash === '#bubble') return <BubbleView />
  if (window.location.hash === '#onboarding') return <Onboarding />
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
