import { listTasks, readBotTranscript, type VaultPaths } from 'core'
import { stopTurn } from './conversation-progress.js'
import { stopLine } from './aside-ipc.js'
import { closingLang } from './task-closing.js'

export interface StopWork {
  ends(channel?: string): Promise<void>[]
  goal(channel: string): string | undefined
  halt(channel?: string): Promise<void>
}

const LIVE = ['queued', 'running', 'waiting']

export function stopper(paths: VaultPaths, work: StopWork): (channel?: string, said?: unknown) => Promise<void> {
  const stopping = new Map<string, Promise<void>>()
  const stop = async (channel?: string, said?: unknown): Promise<void> => {
    const ends = work.ends(channel)
    const live = !!channel && (ends.length > 0 || (await listTasks(paths).catch(() => [])).some(task => `bot-${task.botId}` === channel && LIVE.includes(task.state)))
    const goal = channel ? work.goal(channel) : undefined
    await work.halt(channel)
    await Promise.all(ends)
    if (!channel || !live) return
    const line = typeof said === 'string' && said.trim() && said.length <= 80 ? said.trim() : undefined
    const transcript = channel.startsWith('bot-') ? await readBotTranscript(paths, channel.slice(4), 6).catch(() => []) : []
    await stopTurn(paths, channel, line ?? stopLine(closingLang(transcript, goal ?? '') === 'ko'))
  }
  return (channel, said) => {
    const key = channel ?? ''
    const running = stopping.get(key)
    if (running) return running
    const next = stop(channel, said).finally(() => stopping.delete(key))
    stopping.set(key, next)
    return next
  }
}
