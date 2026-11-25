import { createPidLedger, engineCwd, joinTeam, killAllEngineChildrenSync, loadAbsorbState, normalizeCapture, reclassifyImported, runImport, scanImportFolder, setSpawnObserver, sweepStaleEnginePids } from 'core'
import { app, BrowserWindow, crashReporter, dialog, globalShortcut, ipcMain, Menu, nativeTheme, powerMonitor, screen, session, shell, type WebContents } from 'electron'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NoteDto, OnboardPayload } from '../shared/types.js'
import { registerConfigIpc, registerSettingsIpc, setBrainChoiceHook } from './config-ipc.js'
import { allowNavigation, isAllowedExternalUrl, RENDERER_CSP } from './security.js'
import { detectApiKeyEnv } from './installer.js'
import { exposeResearch } from './research-hook.js'
import { abortAllChat, broadcast, drainAbsorbQueue, registerEngineIpc, registerIpc, revalidateEngines, runPipelineAsync, scheduleAutoTidy, startEngineWatch, toDto } from './ipc.js'
import { fixMacPath } from './macos-path.js'
import { registerMcpIpc } from './mcp-connect.js'
import { setExternalContext } from './external-connection.js'
import { watchNotes, type NotesWatchHandle } from './notes-watch.js'
import { loadSettings } from './settings.js'
import { semanticNotesChanged, startSemantic, stopSemantic, warmSemantic } from './semantic.js'
import { syncSessionContext } from './session-context.js'
import { agentBrowserRunning, closeAgentBrowser, setAgentBrowser } from './agent-browser.js'
import { attachNativeLayout } from './native-layout.js'
import { nativeBrowserEnabled, nativeBrowserRunning } from './native-browser.js'
import { closeClaudeSessions } from './engine-claude.js'
import { closeCodexSessions } from './engine-codex.js'
import { autoImportSession } from './browser-import.js'
import { flog, initLog } from './flog.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { quitGuard } from './quit-guard.js'
import { logResponsiveness, watchResponsiveness } from './performance-health.js'
import { keepWindowState, loadWindowState, placeWindow } from './window-state.js'
import { registerActivityIpc, startActivityWatch, stopActivityWatch } from './activity-watch.js'
import { registerMemoryFabricIpc, startMemoryFabric } from './memory-fabric.js'
import { startKeeper, stopKeeper } from './keeper.js'
import { registerHabitsIpc } from './habits-ipc.js'
import { registerNoticesIpc } from './notices-ipc.js'
import { stopStanding } from './standing.js'
import { installCloudEngines } from './engine-cloud.js'
import { runtimeProcessesRunning, stopRuntimeProcesses } from './process-client.js'
import { registerSessionWatchIpc, startSessionWatch, stopSessionWatch } from './session-watch.js'
import { registerTeamIpc, startAutoSync } from './team.js'
import { createTray, type TrayHandle } from './tray.js'
import { checkForUpdatesNow, installUpdateNow, startUpdater, updateStateNow } from './updater.js'
import { configuredVaultRoot, openVaultContext, resolveEngines, saveVaultRoot, type VaultContext } from './vault.js'
import { finishWorkspaceDeletion } from './workspaces.js'
import { closeDesktopAccess, desktopRestoring, setDesktopOwner } from './desktop-access.js'
import { allowDesktopCapture, registerDesktopIpc } from './desktop-ipc.js'
import { overlayPointer, showControlOverlay } from './desktop-overlay.js'
import { closeOfficeHost, primeOffice } from './office-host.js'
import { stopDesktopControl } from './desktop-control.js'
import { developersRunning, registerDevIpc, stopDevelopers } from './dev-ipc.js'
import { setTaskSurface } from './task-notify.js'
import { setDialogSurface } from './dialog-owner.js'
import { quickCometBounds } from './quick-comet.js'
import { finishAppReset, registerAppReset } from './app-reset.js'
import { mainFocus } from './away-summary.js'
import { quickFileDialogOpen } from './quick-files.js'
import { verifySetupConnection } from './setup-connection.js'
import { aiSelection, chatEngine } from './ai-selection.js'
import { warmFirstLine } from './first-line.js'
import { activeAccountProfile } from './account-profiles.js'
import { recordStalls } from './stall-recorder.js'
import { markFirstSetup } from './first-setup.js'

if (process.env['ENGRAM_USERDATA']) app.setPath('userData', process.env['ENGRAM_USERDATA'])
initLog(join(app.getPath('userData'), 'logs'))

if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('dev.engram.app')

const singleInstance = !app.isPackaged || app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => surfaceMain())
}

function surfaceMain(): void {
  if (!mainWin || mainWin.isDestroyed()) return
  if (mainWin.isMinimized()) mainWin.restore()
  mainWin.show()
  mainWin.focus()
}
setTaskSurface(surfaceMain)
setDialogSurface(() => {
  if (!mainWin || mainWin.isDestroyed() || process.env['ENGRAM_HIDDEN'] === '1') return undefined
  surfaceMain()
  return mainWin.isVisible() ? mainWin : undefined
})

fixMacPath()

if (process.env['ENGRAM_HIDDEN'] !== '1') {
  process.on('uncaughtException', (err) => {
    console.error('uncaughtException (kept alive):', err)
    flog('uncaughtException', err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('unhandledRejection (kept alive):', reason)
    flog('unhandledRejection', reason)
  })
}

crashReporter.start({ uploadToServer: false })
app.on('render-process-gone', (_e, wc, details) => flog('render-process-gone', `${wc.getURL()} → ${details.reason} (${details.exitCode})`))
app.on('child-process-gone', (_e, details) => flog('child-process-gone', `${details.type}/${details.name ?? ''} → ${details.reason} (${details.exitCode})`))

if (process.env['ENGRAM_DISABLE_GPU'] === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const isHidden = process.env['ENGRAM_HIDDEN'] === '1'

let mainWin: BrowserWindow | null = null
let noteStall: (ms: number) => void = () => undefined
let quickWin: BrowserWindow | null = null
let quickOpening = false
let quickAnchor: Electron.Rectangle | null = null
let tray: TrayHandle | null = null
let updateReadyVersion: string | null = null
let quitting = false
let vaultFailed = false
let enginesDetected = false
const watchers: NotesWatchHandle[] = []

const QUICK_CAPTURE_SHORTCUT = 'CommandOrControl+Shift+Space'

async function loadRenderer(win: BrowserWindow, hash?: string): Promise<void> {
  if (isDev) await win.loadURL(process.env['ELECTRON_RENDERER_URL']! + (hash ? `#${hash}` : ''))
  else await win.loadFile(join(import.meta.dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

const webPreferences = {
  preload: join(import.meta.dirname, '../preload/index.mjs'),
  contextIsolation: true,
  nodeIntegration: false,
  backgroundThrottling: !isHidden,
  sandbox: false,
  webviewTag: false,
  allowRunningInsecureContent: false,
  webSecurity: true,
  additionalArguments: !app.isPackaged && isHidden && process.env['ENGRAM_DEVELOPER_FIXTURE'] === '1' ? ['--engram-developer-fixture'] : [],
}

function hardenWebContents(contents: WebContents): void {
  const deny = (event: { preventDefault: () => void }, url: string): void => {
    if (!allowNavigation(url, process.env['ELECTRON_RENDERER_URL'])) {
      console.error('blocked navigation to', url)
      event.preventDefault()
    }
  }
  contents.on('will-navigate', (event, url) => deny(event, url))
  contents.on('will-redirect', (event, url) => deny(event, url))
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    else console.error('blocked window.open to', url)
    return { action: 'deny' }
  })
}

const GROUND = { dark: '#1c1c1c', light: '#ffffff' } as const

function appGround(): string {
  return nativeTheme.shouldUseDarkColors ? GROUND.dark : GROUND.light
}

function titleBarColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors ? { color: GROUND.dark, symbolColor: '#9a9ba6' } : { color: GROUND.light, symbolColor: '#585a66' }
}

const FRAME_ATTEMPT = () => join(app.getPath('userData'), 'window-frame-attempt')
const FRAME_RETRY_MS = 12 * 60 * 60 * 1000

function ownTitleBarIsSafe(): boolean {
  if (process.env['ENGRAM_SYSTEM_FRAME'] === '1') return false
  if (process.platform !== 'win32' && process.platform !== 'darwin') return false
  try {
    const left = statSync(FRAME_ATTEMPT())
    if (Date.now() - left.mtimeMs < FRAME_RETRY_MS) {
      console.warn('[engram] last launch hung drawing its own title bar — using the system frame')
      return false
    }
  } catch {
  }
  return true
}

async function createMainWindow(hash?: string): Promise<void> {
  const framelessOk = ownTitleBarIsSafe()
  if (framelessOk) {
    try {
      writeFileSync(FRAME_ATTEMPT(), '')
    } catch {
    }
  }
  mainWin = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 560,
    show: false,
    backgroundColor: appGround(),
    title: 'Engram',
    ...(framelessOk
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { ...titleBarColors(), height: 44 },
          ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 14 } } : {}),
        }
      : {}),
    webPreferences,
  })
  attachNativeLayout(mainWin)
  setDesktopOwner(mainWin)
  try {
    rmSync(FRAME_ATTEMPT(), { force: true })
  } catch {
  }
  if (!isHidden) {
    placeWindow(mainWin, await loadWindowState())
    keepWindowState(mainWin)
    mainWin.once('ready-to-show', () => {
      if (!quitting && mainWin && !mainWin.isDestroyed()) mainWin.show()
    })
  }
  hardenWebContents(mainWin.webContents)
  nativeTheme.on('updated', () => {
    if (mainWin && !mainWin.isDestroyed()) mainWin.setBackgroundColor(appGround())
    if (framelessOk && mainWin && !mainWin.isDestroyed()) {
      try {
        mainWin.setTitleBarOverlay({ ...titleBarColors(), height: 44 })
      } catch {
      }
    }
  })
  mainWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('renderer gone:', details.reason)
    if (details.reason !== 'clean-exit' && !quitting && mainWin && !mainWin.isDestroyed()) {
      void loadRenderer(mainWin)
    }
  })
  mainWin.webContents.on('unresponsive', () => {
    stopDesktopControl('Engram stopped responding. Computer control was stopped.')
    logResponsiveness('renderer-unresponsive')
  })
  mainWin.webContents.on('responsive', () => logResponsiveness('renderer-responsive'))
  noteStall = recordStalls(mainWin.webContents)
  mainWin.on('enter-full-screen', () => broadcast({ type: 'window:fullscreen', value: true }))
  mainWin.on('focus', () => { broadcast({ type: 'window:focus', value: true }); mainFocus(true) }).on('blur', () => { broadcast({ type: 'window:focus', value: false }); mainFocus(false) })
  mainWin.webContents.on('did-finish-load', () => { const value = mainWin?.isFocused() ?? false; broadcast({ type: 'window:focus', value }); mainFocus(value) })
  mainWin.on('leave-full-screen', () => broadcast({ type: 'window:fullscreen', value: false }))
  mainWin.on('close', (event) => {
    stopDesktopControl('Engram was closed.')
    abortAllChat('panel')
    if (!quitting && !isHidden) {
      event.preventDefault()
      mainWin?.hide()
    }
  })
  await loadRenderer(mainWin, hash)
}

function showMainWindow(): void {
  if (!mainWin) return
  mainWin.show()
  mainWin.focus()
}

async function toggleQuickCapture(): Promise<void> {
  if (quickOpening) return
  const point = screen.getCursorScreenPoint()
  const bounds = quickCometBounds(point, screen.getDisplayNearestPoint(point).workArea)
  quickAnchor = bounds
  if (quickWin && !quickWin.isDestroyed()) {
    if (quickWin.isVisible()) quickWin.hide()
    else {
      quickWin.setBounds(bounds)
      quickWin.show()
      quickWin.focus()
    }
    return
  }
  quickOpening = true
  quickWin = new BrowserWindow({
    ...bounds,
    frame: ownTitleBarIsSafe() ? false : true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    transparent: ownTitleBarIsSafe(),
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences,
  })
  hardenWebContents(quickWin.webContents)
  quickWin.on('blur', () => { if (quickWin && !quickFileDialogOpen(quickWin.webContents.id)) quickWin.hide() })
  quickWin.on('closed', () => { quickWin = null })
  try {
    await loadRenderer(quickWin, 'quick')
    quickWin.show()
    quickWin.focus()
  } catch (error) {
    quickWin?.destroy()
    flog('quick-comet', error)
  } finally { quickOpening = false }
}

async function startResidency(ctx: VaultContext): Promise<void> {
  const settings = await loadSettings()

  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.autoStart })

  if (!isHidden) {
    try {
      tray = createTray({
        onOpen: showMainWindow,
        onQuickCapture: () => void toggleQuickCapture(),
        onQuit: () => {
          quitting = true
          app.quit()
        },
        onInstallUpdate: () => {
          void installUpdateNow(() => { quitting = true })
        },
      })
      if (updateReadyVersion !== null) tray.setUpdateReady(updateReadyVersion)
    } catch (err) {
      console.error('tray unavailable:', err)
    }
    try {
      if (!globalShortcut.register(QUICK_CAPTURE_SHORTCUT, () => void toggleQuickCapture())) {
    console.error(`global shortcut ${QUICK_CAPTURE_SHORTCUT} is taken by another app — use New Comet in the tray menu`)
      }
    } catch (err) {
      console.error('global shortcut registration failed:', err)
    }
  }

  watchers.push(
    watchNotes(ctx.paths.notes, async (events) => {
      const upserts: NoteDto[] = []
      const removed: string[] = []
      for (const { event, path } of events) {
        const delta = await ctx.store.applyFile(event, path)
        for (const note of delta.upserts) upserts.push(toDto(note))
        for (const id of delta.removed) removed.push(id)
      }
      if (upserts.length > 0 || removed.length > 0) {
        broadcast({ type: 'notes:delta', upserts, removed })
        semanticNotesChanged()
      }
    }),
  )

  watchers.push(
    watchNotes(ctx.paths.inbox, (events) => {
      broadcast({ type: 'vault:changed' })
      if (events.some((e) => e.event !== 'unlink')) scheduleAutoTidy(ctx)
    }),
  )

  startAutoSync(ctx, settings.teamSync === 'auto' && !isHidden)
}

function registerBaseIpc(): void {
  registerAppReset(() => mainWin, () => { quitting = true; app.relaunch(); app.quit() })
  ipcMain.handle('quick:show', () => toggleQuickCapture())
  ipcMain.handle('quick:openApp', event => { if (event.sender.id !== quickWin?.webContents.id) return; quickWin.hide(); surfaceMain() })
  ipcMain.handle('quick:layout', (event, requested: unknown) => {
    if (!quickWin || event.sender.id !== quickWin.webContents.id || !quickAnchor || typeof requested !== 'number' || !Number.isFinite(requested)) return
    const area = screen.getDisplayMatching(quickAnchor).workArea
    const height = Math.min(Math.max(88, Math.round(requested)), 320, area.height - 24)
    quickWin.setBounds({ ...quickAnchor, y: Math.max(area.y + 12, quickAnchor.y + quickAnchor.height - height), height })
  })
  ipcMain.on('quick:hide', () => quickWin?.hide())
  ipcMain.on('ui:longtask', (_e, ms: unknown) => { if (typeof ms === 'number' && ms >= 200) { flog('renderer-longtask', `${Math.round(ms)}ms`); noteStall(ms) } })

  ipcMain.handle('update:install', () => {
    return installUpdateNow(() => { quitting = true })
  })

  ipcMain.handle('update:check', () => checkForUpdatesNow())

  ipcMain.handle('update:state', () => updateStateNow())

  ipcMain.handle('vault:isReady', () => booted)

  ipcMain.handle('engines:isDetected', () => enginesDetected)

  ipcMain.handle('vault:revealRoot', (_e, root: string) => {
    void shell.openPath(root)
  })
  ipcMain.handle('app:relaunch', () => {
    quitting = true
    app.relaunch()
    app.quit()
  })

  ipcMain.handle('app:version', () => app.getVersion())

  ipcMain.handle('feedback:open', async () => {
    const env = [
      `Engram ${app.getVersion()}`,
      `${process.platform} ${process.arch}`,
      `electron ${process.versions.electron}`,
    ].join(' · ')
    const body = `**What happened?**\n\n\n**What did you expect?**\n\n\n---\n${env}\n`
    const url = `https://github.com/YunJae00/engram/issues/new?body=${encodeURIComponent(body)}`
    await shell.openExternal(url)
  })

  registerSettingsIpc()
  registerDevIpc()
  registerMcpIpc()

  ipcMain.handle('onboard:defaults', async () => ({
    defaultRoot: process.env['ENGRAM_ONBOARD_ROOT'] ?? join(app.getPath('home'), 'Engram'),
  }))

  ipcMain.handle('import:pick', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('import:scan', async (_e, folder: string) => {
    const scan = await scanImportFolder(folder)
    return { count: scan.files.length, totalBytes: scan.totalBytes }
  })

  ipcMain.handle('onboard:complete', async (_e, payload: OnboardPayload) => {
    const selection = aiSelection(await loadSettings(), 'filing')
    const profile = activeAccountProfile(selection.engine)
    const [engine] = await resolveEngines()
    if (!engine) throw new Error('Connect an AI and verify its connection before continuing.')
    const folder = join(app.getPath('userData'), 'tmp', 'connection-check')
    await mkdir(folder, { recursive: true })
    await verifySetupConnection(engine, engineCwd({ workspace: folder, privateDir: '' }))
    if (profile !== activeAccountProfile(selection.engine) || JSON.stringify(selection) !== JSON.stringify(aiSelection(await loadSettings(), 'filing'))) throw new Error('Your AI selection changed during the check. Try again.')
    if (payload.teamUrl) await joinTeam(payload.root, payload.teamUrl)
    const ctx = await bootVault(payload.root)
    await saveVaultRoot(payload.root)
    await markFirstSetup(ctx)
    if (payload.importFolder) {
      await runImport(ctx.paths, payload.importFolder, {
        onProgress: (done, total) => broadcast({ type: 'import:progress', done, total }),
      })
    }
    if (payload.firstCapture) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await writeFile(join(ctx.paths.inbox, `${stamp}-first-capture.md`), normalizeCapture(payload.firstCapture) + '\n')
      runPipelineAsync(ctx, 'librarian: first capture')
    }
    if (mainWin) await loadRenderer(mainWin)
    if (detectApiKeyEnv().length > 0) console.warn('API key env vars detected — subscription CLIs will be billed via API!')
  })
}

let booted = false
async function runImportTypeMigration(ctx: VaultContext): Promise<void> {
  const marker = join(ctx.paths.cache, 'migrations.json')
  let flags: Record<string, boolean> = {}
  try {
    flags = JSON.parse(await readFile(marker, 'utf8')) as Record<string, boolean>
  } catch {
  }
  if (flags['importedTypeInference']) return
  try {
    const changed = await reclassifyImported(ctx.paths)
    await writeFile(marker, JSON.stringify({ ...flags, importedTypeInference: true }))
    if (changed > 0) broadcast({ type: 'vault:changed' })
  } catch (err) {
    console.error('import-type migration failed (non-fatal):', err)
  }
}

async function bootVault(root: string): Promise<VaultContext> {
  const ctx = await openVaultContext(root)
  setExternalContext(ctx)
  if (!booted) {
    booted = true
    registerIpc(ctx)
    exposeResearch()
    registerTeamIpc(ctx)
    registerConfigIpc(ctx)
    registerHabitsIpc(ctx)
    registerNoticesIpc(ctx)
    await startResidency(ctx).catch((err) => console.error('residency setup failed (non-fatal):', err))
    void revalidateEngines(ctx).then(() => {
      enginesDetected = true
      broadcast({ type: 'engines:detected' })
      void chatEngine(ctx.engines).then(live => warmFirstLine(live, engineCwd(ctx.paths))).catch(() => undefined)
    })
    setBrainChoiceHook(() => revalidateEngines(ctx, true))
    startEngineWatch(ctx)
    void syncSessionContext(ctx)
    void startSessionWatch(ctx)
    startKeeper(ctx)
    void startActivityWatch(ctx)
    powerMonitor.on('resume', () => {
      void revalidateEngines(ctx)
    })
    void runImportTypeMigration(ctx)
    void loadAbsorbState(ctx.paths).then((s) => {
      if (s.pending.length > 0) void drainAbsorbQueue(ctx)
    })
    startMemoryFabric(ctx)
    startSemantic(ctx)
  }
  return ctx
}

app.whenReady().then(async () => {
  if (!singleInstance) return
  if (!await finishAppReset()) { app.quit(); return }
  await finishWorkspaceDeletion()
  await (await import('./account-profiles.js')).initializeAccountProfiles(app.getPath('userData'))
  nativeTheme.themeSource = (await loadSettings()).theme
  watchResponsiveness()
  const enginePidLedger = join(app.getPath('userData'), 'engine-pids.json')
  setSpawnObserver(createPidLedger(enginePidLedger))
  void sweepStaleEnginePids(enginePidLedger).then(({ killed }) => {
    if (killed.length > 0) console.log(`[engram] reaped ${killed.length} engine orphan(s) from a previous run`)
  })
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [RENDERER_CSP] },
      })
    })
  }
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => callback(allowDesktopCapture(wc, permission, details)))
  session.defaultSession.setPermissionCheckHandler((wc, permission, _origin, details) => allowDesktopCapture(wc, permission, details))

  registerBaseIpc()
  registerDesktopIpc()
  void primeOffice()
  const preview = process.env['ENGRAM_OVERLAY_PREVIEW']
  if (preview && !app.isPackaged) setTimeout(() => {
    const engine = preview.startsWith('codex') ? 'codex' : 'claude'
    const paused = preview.endsWith('paused')
    showControlOverlay({ state: paused ? 'paused' : 'running', lane: 'bot-preview', name: 'Book1 - Excel', engine, engineLabel: engine === 'codex' ? 'ChatGPT' : 'Claude', ...(paused ? { resumable: true } : {}) })
    const { workArea } = screen.getPrimaryDisplay()
    const centre = { x: workArea.x + Math.round(workArea.width * 0.62), y: workArea.y + Math.round(workArea.height * 0.55) }
    let tick = 0
    const wander = setInterval(() => {
      const angle = (tick++ % 12) * (Math.PI / 6)
      overlayPointer({ x: centre.x + Math.round(Math.cos(angle) * 18), y: centre.y + Math.round(Math.sin(angle) * 18) }, tick % 6 === 0)
    }, 700)
    wander.unref()
  }, 1_500)
  powerMonitor.on('lock-screen', () => stopDesktopControl('The computer was locked.'))
  powerMonitor.on('suspend', () => stopDesktopControl('The computer is sleeping.'))
  registerEngineIpc()
  registerActivityIpc()
  registerSessionWatchIpc()
  registerMemoryFabricIpc()
  installCloudEngines()
  startUpdater((state) => {
    const ready = state.state === 'ready' || state.state === 'available' ? state.version ?? null : null
    if (ready !== updateReadyVersion) tray?.setUpdateReady(ready ?? undefined)
    updateReadyVersion = ready
    broadcast({ type: 'update:changed', update: state })
  })
  warmSemantic()
  void loadSettings().then((settings) => {
    setAgentBrowser(settings.agentBrowser || null)
    if (!nativeBrowserEnabled()) void autoImportSession(settings.agentBrowser || null).catch(() => undefined)
  })
  const root = await configuredVaultRoot()
  if (root) {
    await createMainWindow()
    flog('boot', `window ready ${Math.round(process.uptime() * 1000)}ms after start`)
    try {
      await bootVault(root)
      broadcast({ type: 'vault:ready' })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('vault failed to open:', err)
      vaultFailed = true
      broadcast({ type: 'vault:error', message, root })
    }
  } else {
    await createMainWindow('onboarding')
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
    else showMainWindow()
  })
})

const markQuit = (step: string): void => {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'quit.log'), `${new Date().toISOString()} ${step}\n`)
  } catch {}
}
const guardQuit = quitGuard(() => { markQuit('retrying shutdown'); app.quit() }, () => { markQuit('forcing shutdown'); app.exit(0) })
app.on('before-quit', (event) => {
  guardQuit()
  markQuit(`before-quit native=${nativeBrowserRunning()} dev=${developersRunning()} runtime=${runtimeProcessesRunning()}`)
  flog('quit', `before-quit native=${nativeBrowserRunning()} dev=${developersRunning()} runtime=${runtimeProcessesRunning()}`)
  stopSemantic()
  stopDesktopControl('Engram is closing.')
  const restoringApps = desktopRestoring()
  const restoredApps = closeDesktopAccess()
  quitting = true
  if (restoringApps || agentBrowserRunning() || nativeBrowserRunning() || developersRunning() || runtimeProcessesRunning()) {
    event.preventDefault()
    abortAllChat()
    void Promise.allSettled([restoredApps, closeAgentBrowser({ force: true }), stopDevelopers()]).finally(stopRuntimeProcesses).finally(() => app.quit())
  }
})

app.on('will-quit', () => {
  markQuit('will-quit')
  void closeAgentBrowser({ force: true })
  markQuit('agent browser')
  closeClaudeSessions()
  markQuit('claude sessions')
  try { closeCodexSessions() } catch (error) { console.error('[will-quit] closeCodexSessions failed', error); flog('engine-codex', error) }
  markQuit('codex sessions')
  closeOfficeHost()
  markQuit('office host')
  globalShortcut.unregisterAll()
  stopSessionWatch()
  stopKeeper()
  stopStanding()
  stopActivityWatch()
  markQuit('watchers')
  for (const watcher of watchers) void watcher.close()
  killAllEngineChildrenSync()
  markQuit('done')
  if (isHidden) app.exit(0)
})
app.on('quit', () => markQuit('quit'))

app.on('window-all-closed', () => {
  if (isHidden || vaultFailed) app.quit()
})
