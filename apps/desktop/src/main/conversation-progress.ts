import { appendBotTurn, withoutSecrets, type VaultPaths } from 'core'
import type { EngramEvent } from '../shared/types.js'
import { asides, turnGoals } from './turn-state.js'
import { broadcast } from './engine-health.js'
import { flog } from './flog.js'

const work = new Map<string, string[]>()
const secretSource = (channel: string): string => [turnGoals.get(channel) ?? '', ...(asides.get(channel) ?? []).map(turn => turn.text)].join('\n')
export function progressWork(channel: string): string[] {
  return (work.get(channel) ?? []).map(line => withoutSecrets(line, `${line}\n${secretSource(channel)}`))
}
const prefixes = new Map<string, string>()
export function finishProgress(channel: string, text: string): string {
  const prefix = prefixes.get(channel)
  prefixes.delete(channel)
  return withoutSecrets(prefix && text.startsWith(prefix) ? text.slice(prefix.length).trimStart() : text, secretSource(channel))
}

export function conversationProgress(paths: VaultPaths) {
  work.clear(); prefixes.clear()
  const pending = new Map<string, string>()
  const flush = (channel: string, fragment = true): Promise<void> => {
    const text = pending.get(channel)
    pending.delete(channel)
    if (!fragment) prefixes.delete(channel)
    if (!text?.trim()) return Promise.resolve()
    if (fragment) prefixes.set(channel, (prefixes.get(channel) ?? '') + text)
    const lines = progressWork(channel)
    work.delete(channel)
    return appendBotTurn(paths, channel.slice(4), {
      work: lines, role: 'assistant', text: withoutSecrets(text, `${text}\n${secretSource(channel)}`), progress: true, at: new Date().toISOString(),
    }).catch(error => flog('conversation-progress', error))
  }
  return {
    flush,
    observe(event: EngramEvent): void {
      if (!('channel' in event) || !event.channel?.startsWith('bot-')) return
      const channel = event.channel
      if (event.type === 'chat:token') {
        if (event.reset) {
          if (event.drop) pending.delete(channel)
          else void flush(channel, false)
        } else pending.set(channel, (pending.get(channel) ?? '') + event.text)
      } else if (event.type === 'comet:step') {
        if (pending.get(channel)?.trim()) broadcast({ type: 'chat:token', channel, text: '', reset: true })
        if (!/^\s*<- /.test(event.line)) work.set(channel, [...(work.get(channel) ?? []).slice(-63), event.line])
      } else if (event.type === 'chat:done' || event.type === 'chat:error') {
        if (event.type === 'chat:error' || !event.text) void flush(channel, false)
        pending.delete(channel); prefixes.delete(channel); work.delete(channel)
      }
    },
  }
}
