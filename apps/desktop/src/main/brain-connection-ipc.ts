import { ipcMain } from 'electron'
import { engineBackoff } from 'core'
import type { BrainConnectionInput, BrainConnectionProvider } from '../shared/types.js'
import { brainConnectionDto, clearBrainConnection, loadBrainConnections, setBrainConnection } from './brain-connections.js'
import { desktopOwner } from './desktop-access.js'
import { broadcast, markEngineOk } from './engine-health.js'
import { updateSettings } from './settings.js'

export function registerConnectionIpc(changed: (provider: BrainConnectionProvider) => Promise<void>): void {
  const providerOf = (value: unknown): BrainConnectionProvider => {
    if (value !== 'claude' && value !== 'codex' && value !== 'decision') throw new Error('Unknown brain.')
    return value
  }
  const handle = (name: string, action: (...args: never[]) => unknown) => ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== desktopOwner()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Connection settings require the main window.')
    return action(...args as never[])
  })
  handle('brain:connectionGet', async (provider: unknown) => { await loadBrainConnections(); return brainConnectionDto(providerOf(provider)) })
  handle('brain:connectionSet', async (provider: unknown, input: unknown) => {
    const chosen = providerOf(provider)
    if (!input || typeof input !== 'object') throw new Error('Enter the address, the key and the model.')
    const result = await setBrainConnection(chosen, input as BrainConnectionInput)
    if (chosen !== 'decision') {
      const settings = await updateSettings(current => ({ ...current, [chosen === 'claude' ? 'claudeModel' : 'codexModel']: result.model, aiSelections: Object.fromEntries(Object.entries(current.aiSelections).map(([scope, selection]) => [scope, selection.engine === chosen ? { ...selection, model: result.model } : selection])) }))
      engineBackoff.noteOk()
      markEngineOk(chosen)
      broadcast({ type: 'settings:changed', settings })
    }
    await changed(chosen)
    return result
  })
  handle('brain:connectionClear', async (provider: unknown) => { const chosen = providerOf(provider); await clearBrainConnection(chosen); await changed(chosen) })
}
