import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renameWithRetry } from './rename-with-retry.js'
import type { VaultPaths } from './vault.js'

export interface NoticeItem {
  id: string
  kind: 'scheduled' | 'habit' | 'system'
  title: string
  text: string
  at: string
  read: boolean
  botId?: string
  key?: string
  running?: boolean
  began?: string
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
