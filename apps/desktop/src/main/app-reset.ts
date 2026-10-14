import { app, dialog, ipcMain, session, type BrowserWindow } from 'electron'
import { lstat, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { validatedWorkspaceRoots } from './workspaces.js'

const RESET_FILES = ['settings.json', 'settings.json.tmp', 'vaults.json', 'vault.json', 'activity-state.json', 'keeper-state.json', 'site-icons.json', 'window-state.json', 'logs', 'tmp']
const markerPath = () => join(app.getPath('userData'), 'reset-request.json')

async function resetTargets(): Promise<string[]> {
  const targets = RESET_FILES.map(name => join(app.getPath('userData'), name))
  for (const path of targets) {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
    if (info?.isSymbolicLink()) throw new Error('Linked app data cannot be reset. Unlink it first.')
  }
  return targets
}

export function registerAppReset(window: () => BrowserWindow | null, restart: () => void): void {
  let resetting = false
  ipcMain.handle('app:reset', async event => {
    const owner = window()
    if (!owner || event.sender.id !== owner.webContents.id) throw new Error('Open Engram Settings to reset the app.')
    if (resetting) throw new Error('A reset is already in progress.')
    resetting = true
    try {
      const roots = await validatedWorkspaceRoots()
      await resetTargets()
      const choice = await dialog.showMessageBox(owner, {
        type: 'warning', title: 'Reset Engram?', message: 'Start again from the first setup screen?',
        detail: `Permanently delete all local Engram conversations, Cosmos notes, saved outputs and settings. No backup will be created. Running tasks will stop.\n\nOriginal files outside these workspaces, AI sign-ins and installed runtimes stay unchanged. Remote backups are not deleted.${roots.length ? `\n\nWorkspaces to delete:\n${roots.join('\n')}` : ''}`,
        buttons: ['Cancel', 'Reset Engram'], defaultId: 0, cancelId: 0, noLink: true,
      })
      if (choice.response !== 1) return false
      await writeFile(markerPath(), JSON.stringify({ roots }))
      // Let the IPC reply leave before shutdown closes its receiving window.
      setImmediate(restart)
      return true
    } finally { resetting = false }
  })
}

// Delete only after the old process has closed its writers and browser sessions.
export async function finishAppReset(): Promise<boolean> {
  const marker = await readFile(markerPath(), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
  if (marker === null) return true
  try {
    const approved = JSON.parse(marker) as { roots?: unknown }
    if (!Array.isArray(approved.roots) || approved.roots.some(root => typeof root !== 'string')) throw new Error('Invalid reset request.')
    const approvedRoots = approved.roots as string[]
    const roots = await validatedWorkspaceRoots()
    if (roots.some(root => !approvedRoots.includes(root))) throw new Error('The workspace list changed. Confirm the reset again.')
    for (const root of approvedRoots.filter(root => !roots.includes(root))) {
      const remaining = await lstat(root).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error })
      if (remaining) throw new Error('A workspace is no longer registered. Confirm the reset again.')
    }
    const targets = await resetTargets()
    for (const root of roots) await rm(root, { recursive: true, force: true })
    await session.defaultSession.clearStorageData({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] })
    for (const path of targets) await rm(path, { recursive: true, force: true })
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: false })
    await rm(markerPath(), { force: true })
    return true
  } catch (error) {
    const choice = await dialog.showMessageBox({ type: 'error', title: 'Engram reset did not finish', message: 'The reset could not be completed.', detail: `${String(error)}\nSome data may already have been deleted. Keep the reset pending to retry on the next launch, or cancel the pending reset to open Engram.`, buttons: ['Keep reset pending', 'Cancel pending reset'], defaultId: 0, cancelId: 0, noLink: true })
    if (choice.response !== 1) return false
    await rm(markerPath(), { force: true })
    return true
  }
}
