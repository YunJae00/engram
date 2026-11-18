import { app, shell } from 'electron'
import updaterPkg from 'electron-updater'
import { flog } from './flog.js'

const { autoUpdater } = updaterPkg

const RELEASES_URL = 'https://github.com/YunJae00/engram/releases/latest'

const SELF_INSTALLS = process.platform !== 'darwin'

interface UpdateCheck {
  state: 'current' | 'downloading' | 'ready' | 'available' | 'checking-unavailable' | 'error'
  version?: string
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
  if (!app.isPackaged) return
  changed = notify
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false

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
  setTimeout(check, 8_000)
  setInterval(check, 6 * 60 * 60_000)
}

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

export function updateStateNow(): UpdateCheck {
  if (!app.isPackaged) return { state: 'checking-unavailable', selfInstalls: SELF_INSTALLS, message: 'not a packaged build' }
  if (!latestSeen || latestSeen === app.getVersion())
    return { state: 'current', version: app.getVersion(), selfInstalls: SELF_INSTALLS }
  if (!SELF_INSTALLS) return { state: 'available', version: latestSeen, selfInstalls: false }
  if (downloadError) return { state: 'error', version: latestSeen, selfInstalls: true, message: downloadError }
  if (downloadedVersion === latestSeen) return { state: 'ready', version: latestSeen, selfInstalls: true }
  return { state: 'downloading', version: latestSeen, selfInstalls: true, percent: downloadPercent }
}

export async function installUpdateNow(beforeInstall: () => void): Promise<{ started: boolean; reason?: string }> {
  if (!app.isPackaged) return { started: false, reason: 'not a packaged build' }
  if (!SELF_INSTALLS) {
    void shell.openExternal(RELEASES_URL)
    return { started: true }
  }
  const fresh = await checkForUpdatesNow()
  if (fresh.state !== 'ready' || !downloadedVersion || downloadedVersion !== latestSeen) {
    flog('updater', `install requested before the download finished (${downloadPercent}%)`)
    return { started: false, reason: fresh.state }
  }
  beforeInstall()
  autoUpdater.quitAndInstall(false, true)
  return { started: true }
}

