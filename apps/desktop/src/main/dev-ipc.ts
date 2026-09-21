import { app, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import type { DevelopersApi } from '../shared/developers.js'
import { desktopOwner } from './desktop-access.js'
import { broadcast } from './engine-health.js'
import { DevService } from './dev-service.js'
import { claudeAccountUsage } from './dev-claude.js'
import { devAccountUsage } from './dev-catalog.js'

let service: DevService | undefined
function get(): DevService {
  service ??= new DevService(join(app.getPath('userData'), 'developers'), update => broadcast({ type: 'dev:changed', update }))
  return service
}
export function registerDevIpc(): void {
  const handle = <K extends keyof DevelopersApi>(name: K, action: DevelopersApi[K]) => {
    ipcMain.handle(name, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (event.sender !== desktopOwner()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Development actions are only available from the main window.')
      return (action as (...args: unknown[]) => unknown)(...args)
    })
  }
  handle('devState', () => get().state())
  handle('devOpenLink', async value => {
    if (typeof value !== 'string' || value.length > 4000) throw new Error('Invalid web link.')
    const url = new URL(value), owner = desktopOwner()
    if (!owner || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only web links without embedded credentials can be opened.')
    const result = await dialog.showMessageBox(owner, { type: 'question', title: 'Open web link?', message: 'Open this link in your default browser?', detail: url.href, buttons: ['Cancel', 'Open link'], defaultId: 0, cancelId: 0 })
    if (result.response === 1) await shell.openExternal(url.href)
  })
  handle('devFiles', (workspace, path) => get().files(workspace, path))
  handle('devConsole', workspace => get().consoleState(workspace))
  handle('devStopCommand', workspace => get().stopCommand(workspace))
  handle('devRunCommand', async (workspace, command) => {
    const owner = desktopOwner()
    if (!owner || typeof command !== 'string' || command.length > 20_000) throw new Error('Invalid command.')
    const cwd = await get().commandFolder(workspace)
    const result = await dialog.showMessageBox(owner, { type: 'warning', title: 'Run workspace command?', message: 'Run this command with your operating-system permissions?', detail: `Folder: ${cwd}\n\n${command}\n\nThis is not sandboxed. Output is saved locally. Do not enter passwords or access tokens.`, buttons: ['Cancel', 'Run command'], defaultId: 0, cancelId: 0 })
    if (result.response !== 1) throw new Error('Command canceled. Nothing was executed.')
    return get().runCommand(workspace, command)
  })
  handle('devSearchFiles', (workspace, query) => get().searchFiles(workspace, query))
  handle('devLanguage', (workspace, path, text, position, kind) => get().language(workspace, path, text, position, kind))
  handle('devCreateFile', (workspace, path) => get().createFile(workspace, path))
  handle('devReadFile', (workspace, path) => get().readFile(workspace, path))
  handle('devSaveFile', (workspace, path, fingerprint, text) => get().saveFile(workspace, path, fingerprint, text))
  handle('devPreferences', patch => get().preferences(patch))
  handle('devAddRepo', async () => {
    const owner = desktopOwner()
    if (!owner) throw new Error('The main window is not available.')
    const picked = await dialog.showOpenDialog(owner, { title: 'Choose a development folder', properties: ['openDirectory'] })
    return picked.canceled || !picked.filePaths[0] ? null : get().addRepo(picked.filePaths[0])
  })
  handle('devRemoveRepo', id => get().removeRepo(id))
  handle('devCreate', request => get().create(request))
  handle('devSession', id => get().session(id))
  handle('devSend', (id, text) => get().send(id, text))
  handle('devStop', id => get().stop(id))
  handle('devRespond', (id, requestId, response) => get().respond(id, requestId, response))
  handle('devExternal', (repo, provider, allFolders, profile) => get().external(repo, provider, allFolders, profile))
  handle('devExternalRead', (repo, provider, id, allFolders, profile) => get().externalRead(repo, provider, id, allFolders, profile))
  handle('devFork', (id, isolate) => get().fork(id, isolate))
  handle('devGit', id => get().git(id))
  handle('devStage', (id, paths, staged, fingerprint) => get().stage(id, paths, staged, fingerprint))
  handle('devCommit', (id, paths, message) => get().commit(id, paths, message))
  handle('devFileReview', (id, path) => get().fileReview(id, path))
  handle('devUndoHunk', (id, path, fingerprint, index) => get().undoHunk(id, path, fingerprint, index))
  handle('devRules', async () => { await get().state(); return get().store.data.rules })
  handle('devRemoveRule', async id => { await get().state(); get().store.data.rules = get().store.data.rules.filter(rule => rule.id !== id); await get().store.save() })
  handle('devUsage', (provider, profile) => {
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.')
    if (service) return service.usage(provider, profile)
    const cwd = app.getPath('userData')
    return provider === 'claude' ? claudeAccountUsage(cwd, profile) : devAccountUsage(cwd, profile)
  })
  handle('devCommands', id => get().commands(id))
  handle('devProjectCommands', (repoId, provider) => get().projectCommands(repoId, provider))
  handle('devConfigure', (id, change) => get().configure(id, change))
}

export async function stopDevelopers(): Promise<void> { await service?.stopAll() }
export function developersRunning(): boolean { return service?.active ?? false }
export function developersBusy(): boolean { return service?.busy ?? false }
