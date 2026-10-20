import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renameWithRetry } from './rename-with-retry.js'
import type { VaultPaths } from './vault.js'

// What Engram brings to the person on its own - a scheduled request that ran,
// a way of working it noticed - kept in one place instead of in conversations
// that drop out of the list after a day. Opening one opens its conversation.

export interface NoticeItem {
  id: string
  kind: 'scheduled' | 'habit'
  title: string
  text: string
  at: string
  read: boolean
  // The conversation it opens; a habit gets one only when it is opened.
  botId?: string
  // The habit it raises.
  key?: string
  running?: boolean
}

const KEEP = 60
const file = (paths: VaultPaths) => join(paths.cache, 'notices.json')

export async function readNotices(paths: VaultPaths): Promise<NoticeItem[]> {
  try {
    const raw = JSON.parse(await readFile(file(paths), 'utf8')) as unknown
    return Array.isArray(raw) ? raw.filter((one): one is NoticeItem => typeof one?.id === 'string' && typeof one?.title === 'string') : []
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

let queue = Promise.resolve()
// One change at a time, so a scheduled run finishing and the person opening
// an item never write over each other.
export function changeNotices(paths: VaultPaths, change: (items: NoticeItem[]) => NoticeItem[]): Promise<NoticeItem[]> {
  const next = queue.then(async () => {
    const items = change(await readNotices(paths)).slice(0, KEEP)
    await mkdir(paths.cache, { recursive: true })
    await writeFile(`${file(paths)}.tmp`, JSON.stringify(items, null, 2))
    await renameWithRetry(`${file(paths)}.tmp`, file(paths))
    return items
  })
  queue = next.then(() => undefined, () => undefined)
  return next
}

export async function addNotice(paths: VaultPaths, item: Omit<NoticeItem, 'id' | 'at' | 'read'>): Promise<NoticeItem> {
  const added: NoticeItem = { ...item, id: randomUUID(), at: new Date().toISOString(), read: false }
  await changeNotices(paths, items => [added, ...items])
  return added
}

export function updateNotice(paths: VaultPaths, id: string, patch: Partial<Omit<NoticeItem, 'id'>>): Promise<NoticeItem[]> {
  return changeNotices(paths, items => items.map(item => item.id === id ? { ...item, ...patch } : item))
}

// A conversation's answer as one plain line for the bell: suggested replies,
// code, rules and markdown marks left out.
export function noticeText(text: string, cap = 280): string {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, ' ')
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, cap)
}
