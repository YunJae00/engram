import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api } from './api.js'
import { AppNotices } from './components/AppNotices.js'
import { AppSidebar } from './components/AppSidebar.js'
import { HelpPanel } from './components/HelpPanel.js'
import { type PaletteAction, type PaletteMode } from './components/Palette.js'
import { TopBar } from './components/TopBar.js'
import { TOUR_DONE_KEY } from './lib/tour.js'
import { BotsView } from './views/BotsView.js'
import { AppProvider } from './state.js'
import { useShellState } from './state-slices.js'
import { t } from './i18n.js'

// Only what the first screen needs is in the first bundle. An editor, a sky
// full of stars, a settings sheet and a walkthrough are all real weight, and
// none of them is on screen when the window opens - fetched when they are
// first asked for, they cost nothing until then. Each is a local file, so
// the wait is a frame, not a download.
const DigestSheet = lazy(() => import('./components/DigestSheet.js').then((m) => ({ default: m.DigestSheet })))
const CosmosChat = lazy(() => import('./components/CosmosChat.js').then((m) => ({ default: m.CosmosChat })))
const MissionControl = lazy(() => import('./views/MissionControl.js').then((m) => ({ default: m.MissionControl })))
const Palette = lazy(() => import('./components/Palette.js').then((m) => ({ default: m.Palette })))
const TourOverlay = lazy(() => import('./components/TourOverlay.js').then((m) => ({ default: m.TourOverlay })))
const ActionDialog = lazy(() => import('./components/ActionDialog.js').then((m) => ({ default: m.ActionDialog })))
const ErrandsSheet = lazy(() => import('./components/ErrandsSheet.js').then((m) => ({ default: m.ErrandsSheet })))
const RoutinesSheet = lazy(() => import('./components/RoutinesSheet.js').then((m) => ({ default: m.RoutinesSheet })))
const GithubConnect = lazy(() => import('./components/GithubConnect.js').then((m) => ({ default: m.GithubConnect })))
const DiagnosticsView = lazy(() => import('./views/DiagnosticsView.js').then((m) => ({ default: m.DiagnosticsView })))
const InboxOverlay = lazy(() => import('./views/InboxOverlay.js').then((m) => ({ default: m.InboxOverlay })))
const ListView = lazy(() => import('./views/ListView.js').then((m) => ({ default: m.ListView })))
const NoteSheet = lazy(() => import('./views/NoteSheet.js').then((m) => ({ default: m.NoteSheet })))
const Onboarding = lazy(() => import('./views/Onboarding.js').then((m) => ({ default: m.Onboarding })))
const QuickCapture = lazy(() => import('./views/QuickCapture.js').then((m) => ({ default: m.QuickCapture })))
const ReviewOverlay = lazy(() => import('./views/ReviewOverlay.js').then((m) => ({ default: m.ReviewOverlay })))
const SettingsView = lazy(() => import('./views/SettingsView.js').then((m) => ({ default: m.SettingsView })))
const SkyView = lazy(() => import('./views/SkyView.js').then((m) => ({ default: m.SkyView })))

function Shell() {
  const { activity, setActivity, engines, pendingWork, toast, showToast, refresh, vaultReady, vaultError, enginesDetected, openNote } = useShellState()
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
  const [routinesOpen, setRoutinesOpen] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('engram.sidebar.open') !== '0')
  useEffect(() => localStorage.setItem('engram.sidebar.open', sidebarOpen ? '1' : '0'), [sidebarOpen])
  // "View in the cosmos" hands over the topic's member ids; the sky consumes
  // them on mount (same seed idiom as chatSeed) and spotlights those stars.
  const [skyFocus, setSkyFocus] = useState<{ ids: string[] } | null>(null)
  // The list mounts the first time it is looked at, then stays.
  const [listSeen, setListSeen] = useState(false)
  useEffect(() => {
    if (activity === 'list') setListSeen(true)
  }, [activity])
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
      // A citation clicked in another window: the main process already
      // surfaced this window; land on the note itself.
      else if (e.type === 'note:open') openNote(e.id)
      else if (e.type === 'brain:setup') setSettingsOpen(true)
    })
  }, [openNote])

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
      } else if (key === 'b') {
        e.preventDefault()
        setSidebarOpen((open) => !open)
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
    const openRoutines = () => setRoutinesOpen(true)
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
      className={`shell sidebar-${sidebarOpen ? 'open' : 'closed'}`}
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
      <AppSidebar
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((value) => !value)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenPalette={() => setPalette('search')}
        onOpenRoutines={() => setRoutinesOpen(true)}
      />
      {sidebarOpen && <button className="sidebar-scrim" aria-label={t('rail.hide')} onClick={() => setSidebarOpen(false)} />}
      <main className="app-main">
        <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((value) => !value)} />
        <AppNotices
          engines={engines}
          enginesDetected={enginesDetected}
          pendingWork={pendingWork}
          updateReady={updateReady}
          updateSelfInstalls={updateSelfInstalls}
          vaultReady={vaultReady}
          onOpenSettings={() => setSettingsOpen(true)}
        />
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
        ) : (
          <>
            {/* Every canvas stays mounted and the inactive ones are hidden:
                switching tabs is then a repaint, not a rebuild, and a thread
                mid-answer or a half-typed draft is exactly where it was. The
                sky is the exception - its canvas animates on its own clock,
                so it mounts when looked at and unmounts when left. */}
            <div className="canvas-slot" hidden={activity !== 'bots'}>
              <BotsView />
            </div>
            {activity === 'mission' && <Suspense fallback={<div className="empty-view" />}><MissionControl /></Suspense>}
            {activity === 'sky' && (
              <Suspense fallback={<div className="empty-view" />}>
                <SkyView focus={skyFocus} onFocusConsumed={() => setSkyFocus(null)} />
              </Suspense>
            )}
            <div className="canvas-slot" hidden={activity !== 'list'}>
              <Suspense fallback={<div className="empty-view" />}>{listSeen && <ListView />}</Suspense>
            </div>
            {/* The launcher IS the panel at rest — never both on screen at once. */}
            <Suspense fallback={null}>{activity === 'sky' && <CosmosChat />}</Suspense>
          </>
        )}
          <HelpPanel />
        </div>
      </main>

      {/* Every one of these is off screen until something opens it, so a
          chunk still on its way shows nothing rather than a spinner. */}
      <Suspense fallback={null}>
        <NoteSheet />
        {digestOpen && <DigestSheet onClose={() => setDigestOpen(false)} />}
        {errandOpen && <ErrandsSheet onClose={() => setErrandOpen(false)} />}
        {routinesOpen && <RoutinesSheet onClose={() => setRoutinesOpen(false)} />}
        <ReviewOverlay />
        <InboxOverlay />
        {palette && <Palette mode={palette} onClose={() => setPalette(null)} onAction={setAction} />}
        {action && <ActionDialog action={action} onClose={() => setAction(null)} />}
        {githubOpen && <GithubConnect onClose={() => setGithubOpen(false)} />}
        {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
        {diagOpen && <DiagnosticsView onClose={() => setDiagOpen(false)} />}
        {tourOpen && <TourOverlay onClose={() => setTourOpen(false)} />}
      </Suspense>
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
  if (window.location.hash === '#quick')
    return (
      <Suspense fallback={null}>
        <QuickCapture />
      </Suspense>
    )
  if (window.location.hash === '#onboarding')
    return (
      <Suspense fallback={null}>
        <Onboarding />
      </Suspense>
    )
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
