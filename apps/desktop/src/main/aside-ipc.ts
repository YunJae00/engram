import { taskQueued, clientTaskQueued, clearClientTaskQueues } from './task-notify.js'
import { ipcMain } from 'electron'
import { appendBotTurn, withoutSecrets, type VaultPaths } from 'core'
import { changeCheckpoint, readCheckpoint } from './comet-checkpoint.js'
import { broadcast, tapBroadcast } from './engine-health.js'
import { flog } from './flog.js'
import { answering, asides, relayed, STEER_CAP, steers, workSoFar } from './turn-state.js'

export interface AsideIpcDeps {
  paths: VaultPaths
  // A turn is running, or a task is still finishing, in this conversation.
  busy(channel: string): boolean
  setOffersAside(botId: string): Promise<void>
}

export function registerAsideIpc(deps: AsideIpcDeps): void {
  ipcMain.removeHandler('chat:queued')
  ipcMain.removeHandler('chat:say')
  ipcMain.removeHandler('chat:steer')
  tapBroadcast((event) => {
    if (event.type === 'comet:step') workSoFar.set(event.channel, [...(workSoFar.get(event.channel) ?? []).slice(-29), event.line])
  })
  const watching = new Set<number>()
  ipcMain.handle('chat:queued', (event, botId: string, pending: boolean) => {
    if (typeof botId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(botId) || typeof pending !== 'boolean') return
    const source = event.sender.id
    if (!watching.has(source)) {
      watching.add(source)
      event.sender.once('destroyed', () => { watching.delete(source); clearClientTaskQueues(source) })
    }
    clientTaskQueued(botId, pending, source)
  })
  ipcMain.handle('chat:say', async (_e, channel: unknown, text: unknown): Promise<{ ok: boolean; reply?: string; action?: 'relay'; instruction?: string }> => {
    if (typeof channel !== 'string' || !channel.startsWith('bot-') || typeof text !== 'string' || !text.trim() || text.length > STEER_CAP) return { ok: false }
    if (!deps.busy(channel)) return { ok: false }
    const said = text.trim()
    const botId = channel.slice('bot-'.length)
    await appendBotTurn(deps.paths, botId, { role: 'user', text: withoutSecrets(said, said), at: new Date().toISOString() })
    await changeCheckpoint(deps.paths, botId, state => ({ ...state, pending: [...new Set([...state.pending, said])] }))
    void deps.setOffersAside(botId).catch(error => flog('study', error))
    asides.set(channel, [...(asides.get(channel) ?? []), { role: 'user', text: said }])
    if (deps.busy(channel)) relayed.set(channel, [...(relayed.get(channel) ?? []), said])
    const pending = await readCheckpoint(deps.paths, botId)
    taskQueued(botId, pending.pending.length > 0)
    return { ok: true, action: 'relay', instruction: said }
  })
  // Words sent mid-turn join the work at its next step instead of waiting for it to finish.
  ipcMain.handle('chat:steer', async (_e, channel: unknown, text: unknown): Promise<boolean> => {
    if (typeof channel !== 'string' || typeof text !== 'string' || !text.trim() || text.length > STEER_CAP || !answering.has(channel)) return false
    if (channel.startsWith('bot-')) {
      await appendBotTurn(deps.paths, channel.slice(4), { role: 'user', text: withoutSecrets(text.trim(), text), at: new Date().toISOString() })
      await changeCheckpoint(deps.paths, channel.slice(4), state => ({ ...state, pending: [...new Set([...state.pending, text.trim()])] }))
    }
    steers.set(channel, [...(steers.get(channel) ?? []), text.trim()])
    broadcast({ type: 'comet:step', channel, line: `you: ${text.trim()}` })
    return true
  })
}
