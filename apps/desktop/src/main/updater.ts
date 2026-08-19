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

export function startUpdater(notify: (version: string, selfInstalls: boolean) => void): void {
  // Packaged only — dev/e2e have no app-update.yml and must never auto-update.
  if (!app.isPackaged) return
  // Downloading what cannot be installed is pure waste of the user's bandwidth.
  autoUpdater.autoDownload = SELF_INSTALLS
  autoUpdater.autoInstallOnAppQuit = SELF_INSTALLS

  // Two different moments mean "tell the user": a platform that installs for
  // itself waits until the bytes are on disk, one that cannot says so as soon
  // as it knows there is something to fetch.
  autoUpdater.on('update-downloaded', (info) => {
    if (!SELF_INSTALLS) return
    flog('updater', `downloaded ${info.version}`)
    latestSeen = info.version
    downloadedVersion = info.version
    downloadPercent = 100
    notify(info.version, true)
  })
  autoUpdater.on('download-progress', (p: { percent?: number }) => {
    downloadPercent = Math.round(p.percent ?? 0)
  })
  autoUpdater.on('update-available', (info) => {
    if (SELF_INSTALLS) return
    flog('updater', `available ${info.version} (manual download — unsigned build)`)
    latestSeen = info.version
    notify(info.version, false)
  })
  autoUpdater.on('error', (err) => {
    console.error('auto-update error (non-fatal):', err)
    flog('updater-error', err)
  })

  const check = () =>
    void autoUpdater.checkForUpdates().catch((err) => {
      console.error('update check failed:', err)
      flog('updater-check-failed', err)
    })
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
    const version = result?.updateInfo?.version
    if (!version || version === app.getVersion()) {
      return { state: 'current', version: app.getVersion(), selfInstalls: SELF_INSTALLS }
    }
    latestSeen = version
    // A build that cannot install itself is 'available' and nothing more; one
    // that can is only restartable once the download has landed.
    if (!SELF_INSTALLS) return { state: 'available', version, selfInstalls: false }
    if (downloadedVersion === version) return { state: 'ready', version, selfInstalls: true }
    return { state: 'downloading', version, selfInstalls: true, percent: downloadPercent }
  } catch (err) {
    flog('updater-check-failed', err)
    return {
      state: 'error',
      selfInstalls: SELF_INSTALLS,
      message: (err instanceof Error ? err.message : String(err)).slice(0, 200),
    }
  }
}

// Returns whether the install actually started. quitAndInstall on a version
// that has not finished downloading is a silent no-op, and a button that does
// nothing is worse than one that explains itself.
export function installUpdateNow(): { started: boolean; reason?: string } {
  if (!app.isPackaged) return { started: false, reason: 'not a packaged build' }
  // On macOS quitAndInstall would quit the app and then fail the signature
  // check, so the click has to lead somewhere that actually works.
  if (!SELF_INSTALLS) {
    void shell.openExternal(RELEASES_URL)
    return { started: true }
  }
  if (!downloadedVersion) {
    flog('updater', `install requested before the download finished (${downloadPercent}%)`)
    return { started: false, reason: 'still downloading' }
  }
  // isSilent=false (show the installer), isForceRunAfter=true (reopen after)
  autoUpdater.quitAndInstall(false, true)
  return { started: true }
}

export function updateDownloadPercent(): number {
  return downloadPercent
}

export function pendingUpdateVersion(): string | null {
  return latestSeen
}
