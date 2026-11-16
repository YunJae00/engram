import { conversationProgress } from './conversation-progress.js'
import { taskQueued, clientTaskQueued, clearClientTaskQueues } from './task-notify.js'
import { ipcMain } from 'electron'
import { appendBotTurn, readBotTranscript, withoutSecrets, type VaultPaths } from 'core'
import { changeCheckpoint, readCheckpoint } from './comet-checkpoint.js'
import { tapBroadcast } from './engine-health.js'
import { flog } from './flog.js'
import { asides, STEER_CAP, turnGoals, workSoFar } from './turn-state.js'

export interface AsideIpcDeps {
  paths: VaultPaths
  // A turn is running, or a task is still finishing, in this conversation.
  busy(channel: string): boolean
  // Queues words said mid-turn to be answered as their own turn; taken before any await so a Stop in between drops them.
  followUp?(channel: string): (text: string) => void
  // The answer of the running turn was delivered; what still runs is the work after it.
  answered?(channel: string): boolean
  setOffersAside(botId: string): Promise<void>
  // Stops everything in this conversation, as the Stop button does; said is the line the thread keeps.
  stop?(channel: string, said: string): Promise<void>
}

// The whole message is a stop ("멈춰", "그만해", "stop"): it stops the work now instead of waiting its turn behind it (grokbar T3).
export const STOP_WORDS = /^\s*(멈춰|멈춰\s?줘|멈춰요|그만|그만\s?해|그만\s?해\s?줘|그만해요|중지|중지\s?해|중지\s?해\s?줘|중단|중단\s?해|중단\s?해\s?줘|스톱|취소|취소\s?해|취소\s?해\s?줘|stop|stop it|cancel|cancel it|abort)\s*[.!~]*\s*$/i

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
  // Turns that said their piece and went on to save what to remember (qa146 S26: "…기억해 둘게요." then keep_in_mind).
  // shortcut: a turn that goes back to real work after a memory save keeps queueing until it ends, track the step after it if that matters.
  const spoke = new Set<string>(), saving = new Set<string>()
  stopListening = tapBroadcast((event) => {
    progress.observe(event)
    if (event.type === 'comet:working') { spoke.delete(event.channel); saving.delete(event.channel) }
    else if (event.type === 'chat:token' && event.channel) {
      if (event.drop) spoke.delete(event.channel); else if (event.text.trim()) spoke.add(event.channel)
      // The reset that closes the short bubble already names the memory tool: no gap until its step arrives.
      else if (event.reset && spoke.has(event.channel) && /(^|__)keep_(in_mind|how_to)$/.test(event.tool ?? '')) saving.add(event.channel)
    }
    else if (event.type === 'comet:step' && spoke.has(event.channel) && /^keep_(in_mind|how_to): /.test(event.line)) saving.add(event.channel)
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
  ipcMain.handle('chat:say', async (_e, channel: unknown, text: unknown): Promise<{ ok: boolean; reply?: string; action?: 'relay' | 'stop'; instruction?: string }> => {
    if (typeof channel !== 'string' || !channel.startsWith('bot-') || typeof text !== 'string' || !text.trim() || text.length > STEER_CAP) return { ok: false }
    const busy = deps.busy(channel)
    if (busy && deps.stop && STOP_WORDS.test(text)) {
      // The thread's language, not the stop word's: a bare "stop" in a Korean thread got "Stopped." (grokbar review r1).
      const korean = [text, turnGoals.get(channel) ?? '', ...(await readBotTranscript(deps.paths, channel.slice('bot-'.length), 6).catch(() => [])).map(turn => turn.text)].some(said => /[가-힣]/.test(said))
      const reply = korean ? '중지했어요.' : 'Stopped.'
      await appendBotTurn(deps.paths, channel.slice('bot-'.length), { role: 'user', text: text.trim(), at: new Date().toISOString(), aside: true })
      // The thread shows the stopped line only while its turn is still open there, so this answer leaves before the stop's own events do
      // (grokbar T3: the turn must end with the line under it, within 3 s).
      setImmediate(() => { void deps.stop!(channel, reply).catch(error => flog('aside', error)) })
      return { ok: true, action: 'stop', reply }
    }
    // Words said after the answer are the next turn, not part of this one: the thread sends them when it ends.
    if (!busy || deps.answered?.(channel) || saving.has(channel)) return { ok: false }
    const hold = deps.followUp?.(channel)
    const said = text.trim()
    const botId = channel.slice('bot-'.length)
    // The running answer is not cut at these words: it is saved whole, and the mark lets the thread show them after it.
    await appendBotTurn(deps.paths, botId, { role: 'user', text: withoutSecrets(said, said), at: new Date().toISOString(), aside: true })
    await changeCheckpoint(deps.paths, botId, state => ({ ...state, pending: [...new Set([...state.pending, said])] })).catch(() => flog('aside', 'checkpoint-write-failed'))
    void deps.setOffersAside(botId).catch(error => flog('study', error))
    asides.set(channel, [...(asides.get(channel) ?? []), { role: 'user', text: said }])
    hold?.(said)
    const pending = await readCheckpoint(deps.paths, botId).catch(() => ({ pending: [said] }))
    taskQueued(botId, pending.pending.length > 0)
    return { ok: true, action: 'relay', instruction: said }
  })
}
