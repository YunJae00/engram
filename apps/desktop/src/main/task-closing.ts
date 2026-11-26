import { appendBotTurn, classifyEngineError, EngineCallError, readBotTranscript, type DelegatedTask, type VaultPaths } from 'core'
import type { EngramEvent } from '../shared/types.js'
import { flog } from './flog.js'
import { signInMessage, usageLimitMessage } from './usage-limit.js'

export type ClosingLang = 'en' | 'ko'
type Turn = { role: string; text: string }

export const ENDED_LOG = 'The turn ended without an answer.'
export const isKorean = (text = ''): boolean => /[가-힣]/.test(text)

export function closingLang(transcript: readonly Turn[], goal: string): ClosingLang {
  const asked = [...transcript].reverse().find(turn => turn.role === 'user')?.text
  return isKorean(asked ?? goal) ? 'ko' : 'en'
}

export async function closeTask(paths: VaultPaths, broadcast: (event: EngramEvent) => void, end: { task?: DelegatedTask; channel?: string; error?: unknown; goal?: string }): Promise<void> {
  const { task, channel, error, goal = task?.goal ?? '' } = end
  if (!channel || (error === undefined && task?.state !== 'failed')) return
  const botId = task?.botId ?? (channel.startsWith('bot-') ? channel.slice(4) : undefined)
  const transcript = botId ? await readBotTranscript(paths, botId).catch(() => []) : []
  const korean = closingLang(transcript, goal) === 'ko'
  const kind = error === undefined ? 'quota' : error instanceof EngineCallError ? error.kind : classifyEngineError(error instanceof Error ? error.message : String(error))
  const message = kind === 'auth' ? signInMessage(korean) : usageLimitMessage(korean)
  if (botId) await appendBotTurn(paths, botId, { role: 'assistant', text: message, at: new Date().toISOString(), error: true, errorKind: kind }).catch(e => flog('tasks', e))
  broadcast({ type: 'chat:error', channel, message, kind })
}
