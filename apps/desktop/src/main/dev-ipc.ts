import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
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
  handle('devExternal', (repo, provider, allFolders) => get().external(repo, provider, allFolders))
  handle('devExternalRead', (repo, provider, id, allFolders) => get().externalRead(repo, provider, id, allFolders))
  handle('devFork', id => get().fork(id))
  handle('devGit', id => get().git(id))
  handle('devCommit', (id, paths, message) => get().commit(id, paths, message))
  handle('devFileReview', (id, path) => get().fileReview(id, path))
  handle('devUndoHunk', (id, path, fingerprint, index) => get().undoHunk(id, path, fingerprint, index))
  handle('devRules', async () => { await get().state(); return get().store.data.rules })
  handle('devRemoveRule', async id => { await get().state(); get().store.data.rules = get().store.data.rules.filter(rule => rule.id !== id); await get().store.save() })
  handle('devUsage', provider => {
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Unknown provider.')
    if (service) return service.usage(provider)
    const cwd = app.getPath('userData')
    return provider === 'claude' ? claudeAccountUsage(cwd) : devAccountUsage(cwd)
  })
  handle('devCommands', id => get().commands(id))
  handle('devProjectCommands', (repoId, provider) => get().projectCommands(repoId, provider))
  handle('devConfigure', (id, change) => get().configure(id, change))
}

export async function stopDevelopers(): Promise<void> { await service?.stopAll() }
export function developersRunning(): boolean { return service?.active ?? false }
export function developersBusy(): boolean { return service?.busy ?? false }
