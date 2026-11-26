import { conversationProgress } from './conversation-progress.js'
import { taskQueued, clientTaskQueued, clearClientTaskQueues } from './task-notify.js'
import { ipcMain } from 'electron'
import { appendBotTurn, readBotTranscript, withoutSecrets, type VaultPaths } from 'core'
import { changeCheckpoint, readCheckpoint } from './comet-checkpoint.js'
import { tapBroadcast } from './engine-health.js'
import { flog } from './flog.js'
import { asides, STEER_CAP, turnGoals, workSoFar } from './turn-state.js'

interface AsideIpcDeps {
  paths: VaultPaths
  busy(channel: string): boolean
  followUp?(channel: string): (text: string) => void
  answered?(channel: string): boolean
  setOffersAside(botId: string): Promise<void>
  stop?(channel: string, said: string): Promise<void>
}

export const STOP_WORDS = /^\s*(멈춰|멈춰\s?줘|멈춰요|그만|그만\s?해|그만\s?해\s?줘|그만해요|중지|중지\s?해|중지\s?해\s?줘|중단|중단\s?해|중단\s?해\s?줘|스톱|취소|취소\s?해|취소\s?해\s?줘|stop|stop it|cancel|cancel it|abort)\s*[.!~]*\s*$/i

let stopListening: (() => void) | undefined
let stopReply: ((channel: string, text: string) => void) | undefined
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
  ipcMain.handle('chat:say', async (_e, channel: unknown, text: unknown): Promise<{ ok: boolean; reply?: string; action?: 'relay' | 'stop' }> => {
    if (typeof channel !== 'string' || !channel.startsWith('bot-') || typeof text !== 'string' || !text.trim() || text.length > STEER_CAP) return { ok: false }
    const busy = deps.busy(channel)
    const inKorean = async (): Promise<boolean> => [text, turnGoals.get(channel) ?? '', ...(await readBotTranscript(deps.paths, channel.slice('bot-'.length), 6).catch(() => [])).map(turn => turn.text)].some(said => /[가-힣]/.test(said))
    if (busy && deps.stop && STOP_WORDS.test(text)) {
      const korean = await inKorean()
      const reply = korean ? '멈췄어요.' : 'Stopped.'
      await changeCheckpoint(deps.paths, channel.slice('bot-'.length), state => state.pending.length ? { ...state, pending: [] } : state).catch(() => flog('aside', 'checkpoint-write-failed'))
      taskQueued(channel.slice('bot-'.length), false)
      await appendBotTurn(deps.paths, channel.slice('bot-'.length), { role: 'user', text: text.trim(), at: new Date().toISOString(), aside: true })
      setImmediate(() => { void deps.stop!(channel, reply).catch(error => flog('aside', error)) })
      return { ok: true, action: 'stop', reply }
    }
    if (!busy || deps.answered?.(channel)) return { ok: false }
    const hold = deps.followUp?.(channel)
    const said = text.trim()
    const botId = channel.slice('bot-'.length)
    await appendBotTurn(deps.paths, botId, { role: 'user', text: withoutSecrets(said, said), at: new Date().toISOString(), aside: true })
    await changeCheckpoint(deps.paths, botId, state => ({ ...state, pending: [...new Set([...state.pending, said])] })).catch(() => flog('aside', 'checkpoint-write-failed'))
    asides.set(channel, [...(asides.get(channel) ?? []), { role: 'user', text: said }])
    hold?.(said)
    void deps.setOffersAside(botId).catch(error => flog('study', error))
    const pending = await readCheckpoint(deps.paths, botId).catch(() => ({ pending: [said] }))
    taskQueued(botId, pending.pending.length > 0)
    return { ok: true, action: 'relay' }
  })
}
