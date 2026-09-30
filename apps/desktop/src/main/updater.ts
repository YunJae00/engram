import { app, shell } from 'electron'
import updaterPkg from 'electron-updater'
import { flog } from './flog.js'

const { autoUpdater } = updaterPkg

const RELEASES_URL = 'https://github.com/YunJae00/engram/releases/latest'

// macOS hands the swap to Squirrel, which refuses any update whose code
// signature does not validate against the running app's — and these builds are
// unsigned. Left alone it downloads 600MB and then rejects it, every time,
// forever. So on macOS the updater is a NOTIFIER: it reports that a version
// exists and opens the download page. Signing with a paid Developer ID is what
// would turn this back into a real self-update.
const SELF_INSTALLS = process.platform !== 'darwin'

export interface UpdateCheck {
  // 'available' means only that a newer version exists. On a platform that
  // installs for itself the bytes still have to arrive, and until they do
  // there is nothing to restart into — that is 'downloading'. Collapsing the
  // two is why Restart now used to do nothing at all.
  state: 'current' | 'downloading' | 'ready' | 'available' | 'checking-unavailable' | 'error'
  version?: string
  // Whether the app can install it itself, or the user has to download it.
  selfInstalls: boolean
  percent?: number
  message?: string
}

let latestSeen: string | null = null
let downloadedVersion: string | null = null
let downloadPercent = 0
let downloadError: string | undefined
let download: Promise<void> | undefined
let downloadingVersion: string | undefined
let changed: (state: UpdateCheck) => void = () => {}

function publish(): void { changed(updateStateNow()) }

function downloadLatest(): void {
  if (!SELF_INSTALLS || download || !latestSeen || downloadedVersion === latestSeen) return
  const version = latestSeen
  downloadingVersion = version
  downloadPercent = 0
  downloadError = undefined
  autoUpdater.autoInstallOnAppQuit = false
  publish()
  // electron-updater shares one download promise. Wait for it to settle before
  // requesting a newer release discovered while the old download was running.
  download = autoUpdater.downloadUpdate().then(() => {}, (err: unknown) => {
    if (version === latestSeen) downloadError = err instanceof Error ? err.message.slice(0, 200) : 'Download failed'
    flog('updater-download-failed', err)
  }).finally(() => {
    download = undefined
    downloadingVersion = undefined
    publish()
    if (version !== latestSeen) downloadLatest()
  })
}

export function startUpdater(notify: (state: UpdateCheck) => void): void {
  // Packaged only — dev/e2e have no app-update.yml and must never auto-update.
  if (!app.isPackaged) return
  // Downloading what cannot be installed is pure waste of the user's bandwidth.
  changed = notify
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

  // Only matching bytes enable installation; an older download can finish
  // after the feed has already announced its replacement.
  autoUpdater.on('update-downloaded', (info) => {
    if (!SELF_INSTALLS) return
    flog('updater', `downloaded ${info.version}`)
    if (info.version !== latestSeen) return
    downloadedVersion = info.version
    downloadPercent = 100
    downloadError = undefined
    autoUpdater.autoInstallOnAppQuit = true
    publish()
  })
  autoUpdater.on('download-progress', (p: { percent?: number }) => {
    if (downloadingVersion !== latestSeen) return
    downloadPercent = Math.round(p.percent ?? 0)
    publish()
  })
  autoUpdater.on('update-available', (info) => {
    // Recorded on every platform: the state snapshot below reads it, and a
    // self-installing platform used to skip this line — so the Settings row
    // said "up to date" while a download was already running.
    if (latestSeen !== info.version) {
      latestSeen = info.version
      downloadedVersion = null
      downloadPercent = 0
      downloadError = undefined
      autoUpdater.autoInstallOnAppQuit = false
    }
    publish()
  })
  autoUpdater.on('update-not-available', () => {
    latestSeen = null
    downloadedVersion = null
    autoUpdater.autoInstallOnAppQuit = false
    publish()
  })
  autoUpdater.on('error', (err) => {
    console.error('auto-update error (non-fatal):', err)
    flog('updater-error', err)
  })

  const check = () => { void checkForUpdatesNow() }
  // A moment after boot so it never competes with first paint, then every 6h
  // for long-running sessions.
  setTimeout(check, 8_000)
  setInterval(check, 6 * 60 * 60_000)
}

// The Settings button. Answers the question the automatic timer answers
// silently, at the moment the user asks it.
export async function checkForUpdatesNow(): Promise<UpdateCheck> {
  if (!app.isPackaged) {
    return { state: 'checking-unavailable', selfInstalls: SELF_INSTALLS, message: 'not a packaged build' }
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) return { state: 'checking-unavailable', selfInstalls: SELF_INSTALLS }
    downloadLatest()
    return updateStateNow()
  } catch (err) {
    flog('updater-check-failed', err)
    return {
      state: 'error',
      selfInstalls: SELF_INSTALLS,
      message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    }
  }
}

// What the updater already knows, with no network round-trip — cheap enough
// for the Settings row to poll while a download runs.
export function updateStateNow(): UpdateCheck {
  if (!app.isPackaged) return { state: 'checking-unavailable', selfInstalls: SELF_INSTALLS, message: 'not a packaged build' }
  if (!latestSeen || latestSeen === app.getVersion())
    return { state: 'current', version: app.getVersion(), selfInstalls: SELF_INSTALLS }
  if (!SELF_INSTALLS) return { state: 'available', version: latestSeen, selfInstalls: false }
  if (downloadError) return { state: 'error', version: latestSeen, selfInstalls: true, message: downloadError }
  if (downloadedVersion === latestSeen) return { state: 'ready', version: latestSeen, selfInstalls: true }
  return { state: 'downloading', version: latestSeen, selfInstalls: true, percent: downloadPercent }
}

// Recheck even a downloaded release before letting the window quit.
export async function installUpdateNow(beforeInstall: () => void): Promise<{ started: boolean; reason?: string }> {
  if (!app.isPackaged) return { started: false, reason: 'not a packaged build' }
  // On macOS quitAndInstall would quit the app and then fail the signature
  // check, so the click has to lead somewhere that actually works.
  if (!SELF_INSTALLS) {
    void shell.openExternal(RELEASES_URL)
    return { started: true }
  }
  const fresh = await checkForUpdatesNow()
  if (fresh.state !== 'ready' || !downloadedVersion || downloadedVersion !== latestSeen) {
    flog('updater', `install requested before the download finished (${downloadPercent}%)`)
    return { started: false, reason: fresh.state }
  }
  // isSilent=false (show the installer), isForceRunAfter=true (reopen after)
  beforeInstall()
  autoUpdater.quitAndInstall(false, true)
  return { started: true }
}

export function updateDownloadPercent(): number {
  return downloadPercent
}

export function pendingUpdateVersion(): string | null {
  return latestSeen
}
