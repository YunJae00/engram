import { app } from 'electron'
import updaterPkg from 'electron-updater'
import { flog } from './flog.js'

const { autoUpdater } = updaterPkg

export function startUpdater(notify: (version: string) => void): void {
  // Packaged only — dev/e2e have no app-update.yml and must never auto-update.
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  // Unsigned build: don't let the Windows publisher-signature check reject an
  // unsigned differential update. (When code signing is added, remove this.)
  autoUpdater.on('update-downloaded', (info) => {
    flog('updater', `downloaded ${info.version}`)
    notify(info.version)
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

export function installUpdateNow(): void {
  if (!app.isPackaged) return
  // isSilent=false (show the installer), isForceRunAfter=true (reopen after)
  autoUpdater.quitAndInstall(false, true)
}
