import { conversationProgress } from './conversation-progress.js'
import { taskQueued, clientTaskQueued, clearClientTaskQueues } from './task-notify.js'
import { ipcMain } from 'electron'
import { appendBotTurn, withoutSecrets, type VaultPaths } from 'core'
import { changeCheckpoint, readCheckpoint } from './comet-checkpoint.js'
import { tapBroadcast } from './engine-health.js'
import { flog } from './flog.js'
import { asides, STEER_CAP, workSoFar } from './turn-state.js'

export interface AsideIpcDeps {
  paths: VaultPaths
  // A turn is running, or a task is still finishing, in this conversation.
  busy(channel: string): boolean
  // Queues words said mid-turn to be answered as their own turn; taken before any await so a Stop in between drops them.
  followUp?(channel: string): (text: string) => void
  setOffersAside(botId: string): Promise<void>
}

let stopListening: (() => void) | undefined
let stopReply: ((channel: string, text: string) => void) | undefined
// The reply a Stop showed, kept in the thread when the stopped turn said nothing yet.
export function noteStopped(channel: unknown, text: unknown): void {
  if (typeof channel === 'string' && channel.startsWith('bot-') && typeof text === 'string' && text.trim() && text.length <= 80) stopReply?.(channel, text.trim())
}

export function registerAsideIpc(deps: AsideIpcDeps): void {
  ipcMain.removeHandler('chat:queued')
  ipcMain.removeHandler('chat:say')
  stopListening?.()
  const progress = conversationProgress(deps.paths)
  stopReply = (channel, text) => { if (deps.busy(channel)) void progress.stop(channel, text) }
  stopListening = tapBroadcast((event) => {
    progress.observe(event)
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
    const hold = deps.followUp?.(channel)
    const said = text.trim()
    const botId = channel.slice('bot-'.length)
    await progress.flush(channel)
    await appendBotTurn(deps.paths, botId, { role: 'user', text: withoutSecrets(said, said), at: new Date().toISOString() })
    await changeCheckpoint(deps.paths, botId, state => ({ ...state, pending: [...new Set([...state.pending, said])] })).catch(() => flog('aside', 'checkpoint-write-failed'))
    void deps.setOffersAside(botId).catch(error => flog('study', error))
    asides.set(channel, [...(asides.get(channel) ?? []), { role: 'user', text: said }])
    hold?.(said)
    const pending = await readCheckpoint(deps.paths, botId).catch(() => ({ pending: [said] }))
    taskQueued(botId, pending.pending.length > 0)
    return { ok: true, action: 'relay', instruction: said }
  })
}
