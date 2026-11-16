import { appendBotTurn, readBotTranscript, withoutSecrets, type VaultPaths } from 'core'
import type { EngramEvent } from '../shared/types.js'
import { asides, turnGoals } from './turn-state.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'
import { firstLineWaiting } from './first-line.js'
import { readsKorean } from '../shared/reads-korean.js'

const work = new Map<string, string[]>()
const secretSource = (channel: string): string => [turnGoals.get(channel) ?? '', ...(asides.get(channel) ?? []).map(turn => turn.text)].join('\n')
export function progressWork(channel: string): string[] {
  return (work.get(channel) ?? []).map(line => withoutSecrets(line, `${line}\n${secretSource(channel)}`))
}
export function finishProgress(channel: string, text: string): string {
  return withoutSecrets(text, secretSource(channel))
}

export function conversationProgress(paths: VaultPaths) {
  work.clear()
  const pending = new Map<string, string>()
  // When the words now waiting were first shown: a line is saved with that time, not the time a tool call froze it (c4 T2, transcriptOrder.ts).
  const since = new Map<string, string>()
  const flush = (channel: string): Promise<void> => {
    const text = pending.get(channel), shownAt = since.get(channel)
    pending.delete(channel); since.delete(channel)
    if (!text?.trim()) return Promise.resolve()
    // Words written mid-work that do not read Korean are not kept in a Korean thread (rule 12; the renderer drops them the same way).
    if (/[\uac00-\ud7a3]/.test(turnGoals.get(channel) ?? '') && !readsKorean(text)) return Promise.resolve()
    const lines = progressWork(channel)
    work.delete(channel)
    return appendBotTurn(paths, channel.slice(4), {
      work: lines, role: 'assistant', text: withoutSecrets(text, `${text}\n${secretSource(channel)}`), progress: true, at: shownAt ?? new Date().toISOString(),
    }).catch(error => flog('conversation-progress', error))
  }
  return {
    flush,
    async stop(channel: string, text: string): Promise<void> {
      if (pending.get(channel)?.trim()) return
      const botId = channel.slice(4)
      const last = (await readBotTranscript(paths, botId, 1).catch(() => []))[0]
      if (last?.role !== 'user') return
      await appendBotTurn(paths, botId, { role: 'assistant', text, work: progressWork(channel), at: new Date().toISOString() }).catch(error => flog('conversation-progress', error))
    },
    observe(event: EngramEvent): void {
      if (!('channel' in event) || !event.channel?.startsWith('bot-')) return
      const channel = event.channel
      if (event.type === 'chat:token') {
        if (event.reset) {
          if (event.drop) { pending.delete(channel); since.delete(channel) }
          else void flush(channel)
        } else { if (!pending.get(channel)) since.set(channel, new Date().toISOString()); pending.set(channel, (pending.get(channel) ?? '') + event.text) }
      } else if (event.type === 'comet:step') {
        // The host's waiting line is not frozen into a bubble by a tool call: it stays live text until the first real words (first-line.ts).
        if (pending.get(channel)?.trim() && !firstLineWaiting(channel)) broadcast({ type: 'chat:token', channel, text: '', reset: true })
        if (!/^\s*<- /.test(event.line)) work.set(channel, [...(work.get(channel) ?? []).slice(-63), event.line])
      } else if (event.type === 'chat:done' || event.type === 'chat:error') {
        if ((event.type === 'chat:error' || !event.text) && !firstLineWaiting(channel)) void flush(channel)
        pending.delete(channel); since.delete(channel); work.delete(channel)
      }
    },
  }
}
