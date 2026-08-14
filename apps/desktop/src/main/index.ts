import { createPidLedger, joinTeam, killAllEngineChildrenSync, loadAbsorbState, normalizeCapture, reclassifyImported, runImport, scanImportFolder, setLocalTransport, setSpawnObserver, sweep, sweepStaleEnginePids } from 'core'
import { app, BrowserWindow, crashReporter, dialog, globalShortcut, ipcMain, Menu, nativeTheme, powerMonitor, session, shell, type WebContents } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { NoteDto, OnboardPayload } from '../shared/types.js'
import { registerConfigIpc, registerSettingsIpc } from './config-ipc.js'
import { allowNavigation, isAllowedExternalUrl, RENDERER_CSP } from './security.js'
import { detectApiKeyEnv } from './installer.js'
import { abortAllChat, broadcast, drainAbsorbQueue, LIBRARIAN_RUN_OPTS, noteRunOutcome, pingEngines, registerIpc, revalidateEngines, runPipelineAsync, scheduleAutoTidy, startEngineWatch, toDto, verifyEngineAuth } from './ipc.js'
import { fixMacPath } from './macos-path.js'
import { autoConnectMcp, registerMcpIpc } from './mcp-connect.js'
import { watchNotes, type NotesWatchHandle } from './notes-watch.js'
import { loadSettings } from './settings.js'
import { registerSemanticIpc, semanticNotesChanged, startSemantic, warmSemantic } from './semantic.js'
import { syncSessionContext } from './session-context.js'
import { flog } from './flog.js'
import { isBubbleVisible, setBubbleVisible, startBubble, stopBubble } from './bubble.js'
import { isActivityWatchEnabled, registerActivityIpc, setActivityWatchEnabled, startActivityWatch, stopActivityWatch } from './activity-watch.js'
import { localComplete, localConfigured, registerLocalLlmIpc, stopLocalServer, warmLocalModel } from './local-llm.js'
import { registerContentCaptureIpc, startContentCapture, stopContentCapture } from './content-capture.js'
import { registerMemoryFabricIpc, startMemoryFabric } from './memory-fabric.js'
import { startKeeper, stopKeeper } from './keeper.js'
import { startSessionWatch, stopSessionWatch } from './session-watch.js'
import { registerTeamIpc, startAutoSync } from './team.js'
import { createTray, type TrayHandle } from './tray.js'
import { installUpdateNow, startUpdater } from './updater.js'
import { configuredVaultRoot, engineStates, openVaultContext, saveVaultRoot, type VaultContext } from './vault.js'
import { registerWorkspaceIpc } from './workspaces.js'

// e2e isolation: must land before app.whenReady touches userData.
if (process.env['ENGRAM_USERDATA']) app.setPath('userData', process.env['ENGRAM_USERDATA'])

const singleInstance = !app.isPackaged || app.requestSingleInstanceLock()
if (!singleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWin || mainWin.isDestroyed()) return
    if (mainWin.isMinimized()) mainWin.restore()
    mainWin.show()
    mainWin.focus()
  })
}

// Must run before anything resolves engines or spawns a pty — see the module
// comment (macOS Dock launches get a PATH without claude/whisper/brew).
fixMacPath()

// Crash resilience (user feedback: "the app closes by itself sometimes"). A
// stray throw in a timer, chokidar callback, powerMonitor/nativeTheme handler,
// or an unawaited rejection would otherwise become an uncaughtException and
// Electron exits the whole app. We log and keep running instead — losing one
// background job is always better than losing the window. A dead renderer is
// reloaded rather than left blank (see createMainWindow). e2e keeps the strict
// behaviour so real test failures still surface.
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

// Escape hatch for machines with broken GPU drivers: software rendering
// keeps the app usable at the cost of compositing speed.
if (process.env['ENGRAM_DISABLE_GPU'] === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const isHidden = process.env['ENGRAM_HIDDEN'] === '1'

let mainWin: BrowserWindow | null = null
let quickWin: BrowserWindow | null = null
// Held for setUpdateReady — and holding it at all keeps the Tray object out
// of GC's reach (a collected Tray silently vanishes from the system tray).
let tray: TrayHandle | null = null
// The updater starts at whenReady but the tray only exists once the vault is
// up (startResidency) — a fast download must not slip through that gap.
let updateReadyVersion: string | null = null
let quitting = false
// Set when the vault could not be opened. Tray residency is started inside
// bootVault, so a failed boot leaves nothing in the tray to click — and then
// keeping the process alive after the last window closes is not residency, it
// is an invisible process holding the single-instance lock so that relaunching
// the app does nothing. Quit instead.
let vaultFailed = false
// Has the first engine detection finished? Queryable as well as broadcast —
// see the engines:isDetected handler.
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
  // ESM preload scripts require an unsandboxed renderer (electron-vite ESM build).
  sandbox: false,
  // Defence in depth (defaults already match, but pin them so a stray edit can't
  // silently weaken the renderer): no <webview>, no mixed content, security on.
  webviewTag: false,
  allowRunningInsecureContent: false,
  webSecurity: true,
}

// Navigation + window.open lockdown for every window's webContents. The renderer
// is a local bundle: it may reload itself but must never navigate to a remote
// origin, and it may not spawn child windows. The only sanctioned external
// navigation (the GitHub backup URL) goes through the vetted openExternal path
// below — never through the renderer opening a window.
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
    // Only vetted https://github.com URLs reach the OS browser; the in-app child
    // window is denied unconditionally.
    if (isAllowedExternalUrl(url)) void shell.openExternal(url)
    else console.error('blocked window.open to', url)
    return { action: 'deny' }
  })
}

// Frameless, Claude-desktop-style window: the top bar IS the title bar.
// Native window controls overlay it on Windows/macOS; Linux keeps its normal
// frame since overlay support there is unreliable.
function titleBarColors(): { color: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { color: '#222329', symbolColor: '#9a9ba6' }
    : { color: '#f9fafc', symbolColor: '#585a66' }
}

async function createMainWindow(hash?: string): Promise<void> {
  const framelessOk = process.platform === 'win32' || process.platform === 'darwin'
  mainWin = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 800,
    minHeight: 560,
    show: !isHidden,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#2e2f36' : '#ffffff',
    title: 'Engram',
    ...(framelessOk
      ? {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: { ...titleBarColors(), height: 52 },
          // macOS puts its window controls on the LEFT — pin them centred in
          // the 52px bar; the renderer reserves matching left padding
          // (see `:root[data-platform="darwin"] .topbar` in styles.css).
          ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 18, y: 18 } } : {}),
        }
      : {}),
    webPreferences,
  })
  hardenWebContents(mainWin.webContents)
  // keep the overlay controls in step with the OS theme
  nativeTheme.on('updated', () => {
    if (framelessOk && mainWin && !mainWin.isDestroyed()) {
      try {
        mainWin.setTitleBarOverlay({ ...titleBarColors(), height: 52 })
      } catch {
        /* not supported on this platform/version */
      }
    }
  })
  // Renderer crash recovery: if the renderer process dies (OOM, GPU fault, an
  // unhandled render error) reload it in place instead of leaving a blank,
  // frozen window that the user has to force-quit — the other half of "closes
  // by itself / hangs" from the feedback.
  mainWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('renderer gone:', details.reason)
    if (details.reason !== 'clean-exit' && !quitting && mainWin && !mainWin.isDestroyed()) {
      void loadRenderer(mainWin)
    }
  })
  mainWin.webContents.on('unresponsive', () => console.error('renderer unresponsive'))
  // macOS fullscreen hides the traffic lights — tell the renderer so the top
  // bar can drop the left padding it reserves for them (and restore on exit).
  mainWin.on('enter-full-screen', () => broadcast({ type: 'window:fullscreen', value: true }))
  mainWin.on('leave-full-screen', () => broadcast({ type: 'window:fullscreen', value: false }))
  mainWin.on('close', (event) => {
    abortAllChat()
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
  if (quickWin && !quickWin.isDestroyed()) {
    if (quickWin.isVisible()) quickWin.hide()
    else {
      quickWin.show()
      quickWin.focus()
    }
    return
  }
  quickWin = new BrowserWindow({
    width: 560,
    height: 220,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#1e1e1e',
    webPreferences,
  })
  hardenWebContents(quickWin.webContents)
  quickWin.on('blur', () => quickWin?.hide())
  await loadRenderer(quickWin, 'quick')
  quickWin.show()
  quickWin.focus()
}

async function startResidency(ctx: VaultContext): Promise<void> {
  const settings = await loadSettings()

  // ⑦ auto start at login (packaged builds only — dev would register tsx).
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: settings.autoStart })

  if (!isHidden) {
    // Tray/shortcut failures (e.g. no StatusNotifier host) degrade quietly —
    // residency is a convenience, never a boot blocker.
    try {
      tray = createTray({
        onOpen: showMainWindow,
        onQuickCapture: () => void toggleQuickCapture(),
        onSweep: () => runSweepNow(ctx),
        onQuit: () => {
          quitting = true
          app.quit()
        },
        // Same contract as the banner button: flip `quitting` first or the
        // main window's own close handler cancels the updater's quit.
        onInstallUpdate: () => {
          quitting = true
          installUpdateNow()
        },
        onToggleBubble: () => {
          const next = !isBubbleVisible()
          setBubbleVisible(next)
          return next
        },
        bubbleVisible: isBubbleVisible,
        onToggleActivity: () => void setActivityWatchEnabled(!isActivityWatchEnabled()),
        activityEnabled: isActivityWatchEnabled,
      })
      if (updateReadyVersion !== null) tray.setUpdateReady(updateReadyVersion)
    } catch (err) {
      console.error('tray unavailable:', err)
    }
    try {
      // register() returns false when another app already owns the combo — it
      // does NOT throw, so the old catch-only handling let a taken hotkey pass
      // in silence. It matters more now that the combo is fixed and cannot be
      // changed from Settings: the tray menu is the fallback, and this line is
      // what tells anyone why the keystroke does nothing.
      if (!globalShortcut.register(QUICK_CAPTURE_SHORTCUT, () => void toggleQuickCapture())) {
        console.error(`global shortcut ${QUICK_CAPTURE_SHORTCUT} is taken by another app — use the tray icon to capture`)
      }
    } catch (err) {
      console.error('global shortcut registration failed:', err)
    }
  }

  // notes/ watcher → NoteStore deltas. Captures, sweeps, absorb and any
  // external/git write to a note .md folds into the in-memory store here and
  // reaches the renderer as a targeted notes:delta (the shell's live update
  // path). The store is the source for notes:list/search:query, so it MUST stay
  // in step with disk regardless of who wrote the file.
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
        semanticNotesChanged() // debounced incremental re-embed
      }
    }),
  )

  // inbox/ watcher: captures arriving from OUTSIDE the app — the MCP
  // satellites (Claude & friends) drop files straight into inbox/ — surface
  // in the scrap pile live and get auto-tidied. Additions only: a sweep
  // consuming the inbox emits unlinks, and scheduling on those would re-arm
  // the auto-tidy forever.
  watchers.push(
    watchNotes(ctx.paths.inbox, (events) => {
      broadcast({ type: 'vault:changed' })
      if (events.some((e) => e.event !== 'unlink')) scheduleAutoTidy(ctx)
    }),
  )

  // ⑧ team sync: start-up + 5-minute pulls, idle push (auto mode).
  startAutoSync(ctx, settings.teamSync === 'auto' && !isHidden)
}

function runSweepNow(ctx: VaultContext): void {
  if (ctx.engines.length === 0) return
  broadcast({ type: 'sweep:start' })
  const modelsDir = join(app.getPath('userData'), 'models')
  void sweep(ctx.paths, ctx.engines, { ...LIBRARIAN_RUN_OPTS, ingest: { provider: ctx.provider, modelsDir } })
    .then((report) => {
      noteRunOutcome(ctx, report)
      broadcast({
        type: 'sweep:done',
        report: {
          executed: report.executed,
          skipped: report.skipped,
          failed: report.failed.length,
          deferred: report.deferred,
          briefWritten: report.briefWritten,
          // The tray sweep is the one path with no UI around it — if it halts
          // on a limit, this field is the only way the user ever hears.
          ...(report.haltReason ? { haltReason: report.haltReason } : {}),
        },
      })
    })
    .catch((err) => {
      broadcast({ type: 'sweep:error', message: String(err) })
      void revalidateEngines(ctx)
    })
    .finally(() => broadcast({ type: 'vault:changed' }))
}

// IPC that must exist BEFORE a vault does (onboarding window).
function registerBaseIpc(): void {
  ipcMain.on('quick:hide', () => quickWin?.hide())

  // "Restart now" on the update banner. `quitting` must be set first: the main
  // window's close handler hides to the tray instead of quitting, which would
  // otherwise cancel the updater's own quit and leave the update pending.
  ipcMain.handle('update:install', () => {
    quitting = true
    installUpdateNow()
  })

  // Lets the renderer know whether the vault IPC surface exists yet — with
  // window-first boot the shell loads while a big vault is still reading, and
  // polling handlers that aren't registered would just log errors.
  ipcMain.handle('vault:isReady', () => booted)

  // Same shape, same reason: detection finishes in the background and its
  // broadcast can land BEFORE the renderer subscribes (or before a reload
  // re-subscribes). A renderer that missed the event would hold "still
  // looking" forever and never show the connect banner, so it can also just
  // ask.
  ipcMain.handle('engines:isDetected', () => enginesDetected)

  // Recovery from a vault that would not open. Both live here rather than in
  // config-ipc because config-ipc is registered by bootVault — precisely the
  // thing that just failed.
  ipcMain.handle('vault:revealRoot', (_e, root: string) => {
    // The folder the app was pointed at, so the user can see for themselves
    // whether it is missing, empty, or still syncing.
    void shell.openPath(root)
  })
  ipcMain.handle('app:relaunch', () => {
    quitting = true
    app.relaunch()
    app.quit()
  })

  // First-run tour gate: real installs only (ENGRAM_TOUR=1 for dev probes) —
  // the coach marks must never intercept e2e clicks.
  ipcMain.handle('app:tourEligible', () => app.isPackaged || process.env['ENGRAM_TOUR'] === '1')
  // Shown in Settings — the first thing to ask when a report comes in is
  // "which version?", and until now nothing in the UI could answer it.
  ipcMain.handle('app:version', () => app.getVersion())

  // Workspace registry/switcher — must work before a vault is booted (onboarding).
  registerWorkspaceIpc()

  // App-level settings likewise: onboarding/quick-capture read them at load,
  // which used to log "No handler registered for 'settings:get'" on machines
  // with no vault configured yet.
  registerSettingsIpc()
  // MCP hookup is app-level too (paths only — no vault access at register time).
  registerMcpIpc()
  // Semantic layer status — the handler exists app-wide; the engine itself
  // starts per vault in bootVault.
  registerSemanticIpc()
  // Zero-click satellites: shortly after boot, self-connect/heal both Claudes
  // so opening the app is the ONLY step the user ever performs.
  setTimeout(() => {
    void autoConnectMcp((targets) => broadcast({ type: 'mcp:autoconnected', targets }))
  }, 5_000)

  ipcMain.handle('onboard:defaults', async () => ({
    defaultRoot: process.env['ENGRAM_ONBOARD_ROOT'] ?? join(app.getPath('home'), 'Engram'),
    // The real per-engine state, so step 2 can say "installed — just log in"
    // instead of showing an engine that simply is not there.
    engines: await engineStates(),
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
    if (payload.teamUrl) await joinTeam(payload.root, payload.teamUrl)
    const ctx = await bootVault(payload.root)
    await saveVaultRoot(payload.root)
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
    if (mainWin) await loadRenderer(mainWin) // onboarding → shell
    if (detectApiKeyEnv().length > 0) console.warn('API key env vars detected — subscription CLIs will be billed via API!')
  })
}

let booted = false
// Marker-guarded, best-effort: a failed migration must never block boot, and
// existing marker flags are preserved when adding this one.
async function runImportTypeMigration(ctx: VaultContext): Promise<void> {
  const marker = join(ctx.paths.cache, 'migrations.json')
  let flags: Record<string, boolean> = {}
  try {
    flags = JSON.parse(await readFile(marker, 'utf8')) as Record<string, boolean>
  } catch {
    /* no marker yet */
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
  if (!booted) {
    booted = true
    registerIpc(ctx)
    registerTeamIpc(ctx)
    registerConfigIpc(ctx)
    await startResidency(ctx).catch((err) => console.error('residency setup failed (non-fatal):', err))
    // Detection moved off the boot path (see openVaultContext). Run it now,
    // in the background, and tell the shell when the answer lands — the shell
    // holds its "no engine" banner until then, because a banner shown during
    // the seconds we are still LOOKING is a false alarm on every launch, and a
    // false alarm on every launch is the best possible training to ignore the
    // real one.
    void revalidateEngines(ctx).then(() => {
      enginesDetected = true
      broadcast({ type: 'engines:detected' })
      if (app.isPackaged || process.env['ENGRAM_HEALTH_PING'] === '1') void pingEngines(ctx)
    })
    startEngineWatch(ctx)
    // Write the session block once at boot, so a Claude session started before
    // the first tidy still gets today's picture rather than yesterday's.
    void syncSessionContext(ctx)
    // While Engram is open, what the user works out in Claude Code accumulates
    // here; closing the app stops it. The app IS the switch.
    void startSessionWatch(ctx)
    // The weekly keeper: gardener (shelve the unrecalled) + skill distiller
    // (recurring know-how → real ~/.claude/skills). Receipts, never questions.
    startKeeper(ctx)
    void startActivityWatch(ctx)
    startContentCapture(ctx)
    if (!isHidden) {
      void startBubble({
        webPreferences,
        loadRenderer,
        harden: hardenWebContents,
        showMainWindow,
        onQuit: () => {
          quitting = true
          app.quit()
        },
      }).catch((err) => console.error('bubble unavailable (non-fatal):', err))
    }
    powerMonitor.on('resume', () => {
      void verifyEngineAuth(ctx).then(() => revalidateEngines(ctx))
    })
    // One-time migration: reclassify pre-inference 'imported' notes by their
    // source folder (marker-guarded so it never re-runs).
    void runImportTypeMigration(ctx)
    // Resume absorbing any import backlog a previous session left queued.
    void loadAbsorbState(ctx.paths).then((s) => {
      if (s.pending.length > 0) void drainAbsorbQueue(ctx)
    })
    // Semantic memory: bring the local embedding layer up in the background
    // (first packaged boot downloads the model once; failures degrade to
    // lexical search silently).
    startMemoryFabric(ctx)
    startSemantic(ctx)
    // Load the model while nobody is waiting, in the worker where it cannot
    // freeze a window — the first question then answers straight away.
    setTimeout(() => void warmLocalModel(), 20_000)
  }
  return ctx
}

app.whenReady().then(async () => {
  // Lost the single-instance race: quit was already requested above, so boot
  // nothing — no window, no vault, no watchers on a vault another process owns.
  if (!singleInstance) return
  // Engine child bookkeeping, before anything can spawn one: every spawn is
  // ledgered as it happens, and whatever a CRASHED previous run left listed
  // gets adjudicated now (kill only on full agreement — see reaper.ts; the
  // clean-exit path is the will-quit hook). Fire-and-forget: the janitor is
  // never allowed to slow a boot.
  const enginePidLedger = join(app.getPath('userData'), 'engine-pids.json')
  setSpawnObserver(createPidLedger(enginePidLedger))
  void sweepStaleEnginePids(enginePidLedger).then(({ killed }) => {
    if (killed.length > 0) console.log(`[engram] reaped ${killed.length} engine orphan(s) from a previous run`)
  })
  // No File/Edit menu bar — the app's own top bar is the only chrome.
  // (macOS keeps the default menu so system copy/paste shortcuts survive.)
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
  // Strict CSP on the bundled renderer (production/e2e only — the Vite dev
  // server needs 'unsafe-eval' + ws: for HMR, and dev already loads from a
  // trusted localhost origin). The renderer serves only its own assets, so a
  // self-scoped policy holds without breaking bundled fonts/styles.
  if (!isDev) {
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [RENDERER_CSP] },
      })
    })
  }
  // Deny every renderer permission request. Engram needs none of them — no
  // camera, microphone, geolocation, notifications, clipboard-read or
  // pointer-lock — and Electron's default is to ASK, which would put a real
  // OS prompt in front of the user if anything in the renderer ever requested
  // one. Audio capture goes through the main process, never getUserMedia.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)

  registerBaseIpc()
  registerActivityIpc()
  registerLocalLlmIpc()
  registerContentCaptureIpc()
  registerMemoryFabricIpc()
  // The core adapter learns where the local brain lives (started on demand).
  setLocalTransport({ complete: localComplete, configured: localConfigured })
  // Auto-update: check the public release feed and self-update in the
  // background (packaged only; installs on next quit). One toast when ready.
  startUpdater((version) => {
    // Both surfaces at once: the window banner (visible if it's open) and the
    // tray menu item (visible even when it never is).
    updateReadyVersion = version
    broadcast({ type: 'update:ready', version })
    tray?.setUpdateReady(version)
  })
  // Semantic model warm-up: needs no vault, so the ~600MB first-run download
  // overlaps the onboarding walk instead of starting after it.
  warmSemantic()
  const root = await configuredVaultRoot()
  if (root) {
    await createMainWindow()
    try {
      await bootVault(root)
      broadcast({ type: 'vault:ready' })
    } catch (err) {
      // A throw here used to escape into the whenReady promise and vanish: the
      // window stayed on its opening state with no message, no tray (residency
      // is started INSIDE bootVault), and — packaged — closing it left a
      // process still holding the single-instance lock, so relaunching did
      // nothing at all. The only way out was Task Manager.
      //
      // Nothing in the vault path is exotic enough to trust: a notes folder on
      // a disconnected network drive, a workspace inside OneDrive mid-sync, a
      // vault root the user moved or renamed while the app was closed. Say what
      // happened and where, and let the shell offer a way out.
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

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // Closing the app is the user saying "stop remembering from here".
  stopSessionWatch()
  stopBubble()
  stopKeeper()
  stopActivityWatch()
  stopLocalServer()
  void stopContentCapture()
  for (const watcher of watchers) void watcher.close()
  killAllEngineChildrenSync()
})

app.on('window-all-closed', () => {
  // With tray residency the app lives on; e2e/hidden mode quits normally, and
  // so does a boot that never got as far as creating the tray.
  if (isHidden || vaultFailed) app.quit()
})
