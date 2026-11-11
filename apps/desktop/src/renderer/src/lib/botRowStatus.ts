import type { BotDto } from '../../../shared/types.js'
import type { CometActivity } from './cometActivity.js'

export type RowStatus = 'attention' | 'working' | 'unread' | null

export function rowStatus(activity: CometActivity, unread: boolean): RowStatus {
  if (activity === 'waiting' || activity === 'error') return 'attention'
  if (activity === 'running') return 'working'
  return unread ? 'unread' : null
}

export function unreadAfter(seen: string | undefined, last: BotDto['lastMessage'], active: boolean): { seen: string; unread: boolean } {
  const key = last ? `${last.role}|${last.at ?? ''}|${last.text}` : ''
  if (seen === undefined || active) return { seen: key, unread: false }
  return { seen, unread: last?.role === 'assistant' && key !== seen }
}

const seenKeys = new Map<string, string>()

export function markUnread(id: string, last: BotDto['lastMessage'], active: boolean): boolean {
  const next = unreadAfter(seenKeys.get(id), last, active)
  seenKeys.set(id, next.seen)
  return next.unread
}
