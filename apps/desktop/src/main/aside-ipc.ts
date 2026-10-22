import { ipcMain } from 'electron'
import { asidePrompt, parseAside, readBotTranscript, type AsideAction, type VaultPaths } from 'core'
import { broadcast, tapBroadcast } from './engine-health.js'
import { flog } from './flog.js'
import { answering, asides, relayed, STEER_CAP, steers, turnGoals, workSoFar } from './turn-state.js'

export interface AsideIpcDeps {
  paths: VaultPaths
  // A turn is running, or a task is still finishing, in this conversation.
  busy(channel: string): boolean
  // The conversation's kept-open voice, or null when its brain has none.
  voice(channel: string, prompt: string, timeoutMs: number): Promise<string | null>
  setOffersAside(botId: string): Promise<void>
}

// Talking to a comet while it works: the voice that answers at once, and the
// words that reach the running turn at its next step.
export function registerAsideIpc(deps: AsideIpcDeps): void {
  ipcMain.removeHandler('chat:say')
  ipcMain.removeHandler('chat:steer')
  tapBroadcast((event) => {
    if (event.type === 'comet:step') workSoFar.set(event.channel, [...(workSoFar.get(event.channel) ?? []).slice(-29), event.line])
  })
  // Said while the work runs: answered at once by a short call that sees what
  // the work has done, which also decides what the words mean for the work.
  ipcMain.handle('chat:say', async (_e, channel: unknown, text: unknown): Promise<{ ok: boolean; reply?: string; action?: AsideAction; instruction?: string }> => {
    if (typeof channel !== 'string' || !channel.startsWith('bot-') || typeof text !== 'string' || !text.trim() || text.length > STEER_CAP) return { ok: false }
    if (!deps.busy(channel)) return { ok: false }
    const said = text.trim()
    const botId = channel.slice('bot-'.length)
    void deps.setOffersAside(botId).catch(error => flog('study', error))
    asides.set(channel, [...(asides.get(channel) ?? []), { role: 'user', text: said }])
    const earlier = await readBotTranscript(deps.paths, botId, 12).catch(() => [])
    const quickly = await deps.voice(channel, asidePrompt({ goal: turnGoals.get(channel) ?? '', work: workSoFar.get(channel) ?? [], said: [...earlier, ...(asides.get(channel) ?? []).slice(0, -1)], message: said }), 12_000).catch((error: unknown) => { flog('aside', `quick: ${error instanceof Error ? error.message : String(error)}`); return null })
    // Without a voice in seconds, the words still reach the work.
    const aside = parseAside(quickly) ?? { reply: '', action: 'relay' as const, instruction: said }
    if (aside.reply) asides.set(channel, [...(asides.get(channel) ?? []), { role: 'assistant', text: aside.reply }])
    const running = deps.busy(channel)
    if (aside.action === 'relay' && running) {
      relayed.set(channel, [...(relayed.get(channel) ?? []), aside.instruction!])
    }
    flog('aside', `${channel}: ${aside.action}`)
    // A relay that found the work already finished goes on as the next message.
    return { ok: true, reply: aside.reply, action: aside.action === 'relay' && !running ? 'later' : aside.action, ...(aside.instruction ? { instruction: aside.instruction } : {}) }
  })
  // Words sent mid-turn join the work at its next step instead of waiting for it to finish.
  ipcMain.handle('chat:steer', (_e, channel: unknown, text: unknown): boolean => {
    if (typeof channel !== 'string' || typeof text !== 'string' || !text.trim() || text.length > STEER_CAP || !answering.has(channel)) return false
    steers.set(channel, [...(steers.get(channel) ?? []), text.trim()])
    broadcast({ type: 'comet:step', channel, line: `you: ${text.trim()}` })
    return true
  })
}
