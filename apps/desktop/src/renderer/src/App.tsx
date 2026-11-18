import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { api } from './api.js'
import { AppNotices, Toast, useToastDismiss } from './components/AppNotices.js'
import { AppSidebar } from './components/AppSidebar.js'
import { TopBar } from './components/TopBar.js'
import { ComputerStatus } from './components/ComputerStatus.js'
import { dismissSidebar, useSidebarEscape } from './lib/sidebarOverlay.js'
import { isNewBotShortcut } from './lib/newBotShortcut.js'
import { BotsView } from './views/BotsView.js'
import { AppProvider } from './state.js'
import { useShellState } from './state-slices.js'
import { t } from './i18n.js'
import { threadLang, threadWords } from './lib/threadLang.js'
import { cometThreads, selectComet } from './lib/cometThreadsLive.js'
import { ArtifactSheet } from './components/ArtifactSheet.js'
import type { FirstSetupDto, UpdateCheckDto } from '../../shared/types.js'
import { FirstSetup } from './components/FirstSetup.js'

const CosmosChat = lazy(() => import('./components/CosmosChat.js').then((m) => ({ default: m.CosmosChat })))
const ControlOverlay = lazy(() => import('./views/ControlOverlay.js').then((m) => ({ default: m.ControlOverlay })))
const ControlPill = lazy(() => import('./views/ControlPill.js').then((m) => ({ default: m.ControlPill })))
const DiagnosticsView = lazy(() => import('./views/DiagnosticsView.js').then((m) => ({ default: m.DiagnosticsView })))
const InboxOverlay = lazy(() => import('./views/InboxOverlay.js').then((m) => ({ default: m.InboxOverlay })))
const ListView = lazy(() => import('./views/ListView.js').then((m) => ({ default: m.ListView })))
const NoteSheet = lazy(() => import('./views/NoteSheet.js').then((m) => ({ default: m.NoteSheet })))
const Onboarding = lazy(() => import('./views/Onboarding.js').then((m) => ({ default: m.Onboarding })))
const QuickCapture = lazy(() => import('./views/QuickCapture.js').then((m) => ({ default: m.QuickCapture })))
const ReviewOverlay = lazy(() => import('./views/ReviewOverlay.js').then((m) => ({ default: m.ReviewOverlay })))
const SettingsView = lazy(() => import('./views/SettingsView.js').then((m) => ({ default: m.SettingsView })))
const SkyView = lazy(() => import('./views/SkyView.js').then((m) => ({ default: m.SkyView })))
const DevelopersView = lazy(() => import('./views/DevelopersView.js').then((m) => ({ default: m.DevelopersView })))

let settingsHeld = { open: false }

function Shell() {
  const { activity, setActivity, engines, pendingWork, toast, vaultReady, vaultError, enginesDetected, openNote, showToast } = useShellState()
  const hideToast = useToastDismiss()
  const [workspace, setWorkspace] = useState<'developers' | 'bots'>('bots')
  const developerSidebar = api.developerUiEnabled && (activity === 'developers' || (activity !== 'bots' && workspace === 'developers'))
  useEffect(() => { if (activity === 'developers') setWorkspace('developers'); else if (activity === 'bots') setWorkspace('bots') }, [activity])
  const [settingsOpen, setSettingsOpen] = useState(settingsHeld.open)
  useEffect(() => { settingsHeld = { open: settingsOpen } }, [settingsOpen])
  useEffect(() => {
    if (!api.developerUiEnabled) return
    const open = () => { setSettingsOpen(false); setActivity('developers') }
    const settings = () => setSettingsOpen(true)
    window.addEventListener('engram:open-developers', open)
    window.addEventListener('engram:open-developer-settings', settings)
    return () => { window.removeEventListener('engram:open-developers', open); window.removeEventListener('engram:open-developer-settings', settings) }
  }, [setActivity])
  const [diagOpen, setDiagOpen] = useState(false)
  const [devLayout, setDevLayout] = useState<1 | 2 | 4>(1)
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem('engram.sidebar.open') !== '0')
  useEffect(() => localStorage.setItem('engram.sidebar.open', sidebarOpen ? '1' : '0'), [sidebarOpen])
  const closeSidebar = useCallback(() => setSidebarOpen(false), [])
  useSidebarEscape(sidebarOpen, closeSidebar)
  const [skyFocus, setSkyFocus] = useState<{ ids: string[] } | null>(null)
  const [listSeen, setListSeen] = useState(false)
  useEffect(() => {
    if (activity === 'list') setListSeen(true)
  }, [activity])
  const [update, setUpdate] = useState<UpdateCheckDto | null>(null)
  useEffect(() => {
    return api.onEvent((e) => {
      if (e.type === 'update:changed') {
        setUpdate(e.update)
      }
      else if (e.type === 'note:open') openNote(e.id)
      else if (e.type === 'task:notice') showToast(e.foreground ? threadWords(threadLang(cometThreads.thread(e.foreground.lane.replace(/^bot-/, '')).messages)).foregroundTaken(e.foreground.app) : e.message)
      else if (e.type === 'brain:setup') setSettingsOpen(true)
      else if (e.type === 'routine:chat' || e.type === 'comet:open' || e.type === 'comet:quick') {
        if (e.type === 'comet:quick') setSettingsOpen(false)
        selectComet(e.botId); setActivity('bots')
        if (window.innerWidth <= 900) setSidebarOpen(false)
      }
    })
  }, [openNote, showToast])

  const [artifactId, setArtifactId] = useState<string | null>(null)
  const [setup, setSetup] = useState<FirstSetupDto | null>()
  const [leaving, setLeaving] = useState(false)
  const [fromSetup, setFromSetup] = useState(false)
  useEffect(() => {
    if (!vaultReady) return
    let alive = true
    let waited = false
    void api.firstSetupStatus().then(status => { if (alive) { waited = status.waiting; setSetup(status) } }).catch(() => { if (alive) setSetup(null) })
    const off = api.onEvent(event => {
      if (event.type !== 'firstSetup:changed') return
      if (waited && !event.status.waiting) { setLeaving(true); setFromSetup(true) }
      waited = event.status.waiting
      setSetup(event.status)
    })
    return () => { alive = false; off() }
  }, [vaultReady])
  useEffect(() => {
    if (!leaving) return
    const timer = window.setTimeout(() => setLeaving(false), 900)
    return () => window.clearTimeout(timer)
  }, [leaving])
  const settingUp = !!setup?.waiting || leaving || (vaultReady && setup === undefined)
  useLayoutEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (isNewBotShortcut(e)) {
        e.preventDefault()
        window.dispatchEvent(new Event('engram:open-create-bot'))
        return
      }
      if (key === 'b') {
        e.preventDefault()
        setSidebarOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  useEffect(() => {
    const openDiag = () => setDiagOpen(true)
    const focusCapture = () => {
      setActivity('sky')
    }
    const focusSky = (event: Event) => {
      const ids = (event as CustomEvent<{ ids?: string[] }>).detail?.ids
      if (ids && ids.length > 0) setSkyFocus({ ids })
    }
    const openBrainSetup = () => setSettingsOpen(true)
    const openHelp = () => setSettingsOpen(true)
    window.addEventListener('engram:open-help', openHelp)
    window.addEventListener('engram:open-brain-setup', openBrainSetup)
    window.addEventListener('engram:open-diagnostics', openDiag)
    const openArtifact = (event: Event) => {
      const id = String((event as CustomEvent<string>).detail)
      if (/\.(md|txt|csv|tsv|json)$/i.test(id)) setArtifactId(id)
      else void window.engram.artifactOpen(id).catch(() => setArtifactId(id))
    }
    window.addEventListener('engram:open-artifact', openArtifact)
    window.addEventListener('engram:focus-capture', focusCapture)
    window.addEventListener('engram:sky-focus', focusSky)
    return () => {
      window.removeEventListener('engram:open-brain-setup', openBrainSetup)
      window.removeEventListener('engram:open-help', openHelp)
      window.removeEventListener('engram:open-diagnostics', openDiag)
      window.removeEventListener('engram:open-artifact', openArtifact)
      window.removeEventListener('engram:focus-capture', focusCapture)
      window.removeEventListener('engram:sky-focus', focusSky)
    }
  }, [])

  if (vaultReady && setup === undefined) return null
  if (settingUp && setup) return <FirstSetup status={setup} leaving={leaving} />

  return (
    <div
      className={`shell sidebar-${sidebarOpen ? 'open' : 'closed'}${fromSetup ? ' arriving' : ''}`}
      data-testid="shell"
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'none' }}
      onDrop={(event) => event.preventDefault()}
    >
      <AppSidebar
        developer={developerSidebar}
        open={sidebarOpen}
        onToggle={() => setSidebarOpen((value) => !value)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      {sidebarOpen && <button className="sidebar-scrim" aria-label={t('rail.hide')} onClick={() => dismissSidebar(closeSidebar)} />}
      <main className="app-main">
        <TopBar sidebarOpen={sidebarOpen} developer={developerSidebar} onToggleSidebar={() => setSidebarOpen((value) => !value)} onMode={setActivity} devLayout={devLayout} onDevLayout={setDevLayout} />
        <AppNotices
          engines={engines}
          enginesDetected={enginesDetected}
          pendingWork={pendingWork}
          update={update}
          vaultReady={vaultReady}
          onOpenSettings={() => setSettingsOpen(true)}
        />
        <div className="canvas">
        {vaultError ? (
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
            <div className="canvas-slot" hidden={activity !== 'bots'}>
              <BotsView active={activity === 'bots'} />
            </div>
            {developerSidebar && <div className="canvas-slot" hidden={activity !== 'developers'}><Suspense fallback={<div className="empty-view" role="status">Loading development workspace…</div>}><DevelopersView layout={devLayout} onLayout={setDevLayout} onActivate={() => setActivity('developers')} /></Suspense></div>}
            {activity === 'sky' && (
              <Suspense fallback={<div className="empty-view" />}>
                <SkyView focus={skyFocus} onFocusConsumed={() => setSkyFocus(null)} />
              </Suspense>
            )}
            <div className="canvas-slot" hidden={activity !== 'list'}>
              <Suspense fallback={<div className="empty-view" />}>{listSeen && <ListView />}</Suspense>
            </div>
            <Suspense fallback={null}>{activity === 'sky' && <CosmosChat />}</Suspense>
          </>
        )}
        </div>
      </main>

      <Suspense fallback={null}>
        <NoteSheet />
        <ReviewOverlay />
        <InboxOverlay />
        {artifactId && <ArtifactSheet id={artifactId} onClose={() => setArtifactId(null)} />}
        {settingsOpen && <SettingsView onClose={() => setSettingsOpen(false)} />}
        {diagOpen && <DiagnosticsView onClose={() => setDiagOpen(false)} />}
      </Suspense>
      {toast && <Toast key={toast.id} message={toast.message} onDone={hideToast} />}
      <ComputerStatus />
    </div>
  )
}

export function App() {
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
  if (window.location.hash === '#overlay')
    return (
      <Suspense fallback={null}>
        <ControlOverlay />
      </Suspense>
    )
  if (window.location.hash === '#overlay-pill')
    return (
      <Suspense fallback={null}>
        <ControlPill />
      </Suspense>
    )
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  )
}
