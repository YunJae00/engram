import { readBotTranscript, type DelegatedTask, type VaultPaths } from 'core'
import type { EngramEvent } from '../shared/types.js'
import { usageLimitMessage } from './usage-limit.js'

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
  if (!channel) return
  if (error !== undefined) { broadcast({ type: 'chat:error', channel, message: error instanceof Error ? error.message : String(error) }); return }
  if (task?.state !== 'failed') return
  const transcript = await readBotTranscript(paths, task.botId).catch(() => [])
  broadcast({ type: 'chat:error', channel, message: usageLimitMessage(closingLang(transcript, goal) === 'ko') })
}
