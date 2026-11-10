import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readBotTranscript, type Bot, type VaultPaths } from 'core'
import { updateBot, type BotPatch } from 'core/src/bots'
import type { BotConversationDto, BotDto } from '../shared/types.js'

const cached = new Map<string, { stamp: string; value: Promise<BotDto['lastMessage']> }>()

export async function botPreviews(paths: VaultPaths, bots: Bot[]): Promise<BotDto[]> {
  const rows: BotDto[] = []
  for (let offset = 0; offset < bots.length; offset += 8) {
    rows.push(...await Promise.all(bots.slice(offset, offset + 8).map(async bot => {
      if (!/^[\w-]+$/.test(bot.id)) return bot
      const path = join(paths.cache, 'bot-chats', `${bot.id}.jsonl`)
      try {
        const info = await stat(path)
        const stamp = `${info.mtimeMs}:${info.size}`
        let held = cached.get(path)
        if (!held || held.stamp !== stamp) {
          const value = readBotTranscript(paths, bot.id).then(turns => {
            const turn = turns.filter(turn => !turn.progress).at(-1)
            return turn ? { role: turn.role, text: turn.text.replace(/\s+/g, ' ').trim().slice(0, 200), at: turn.at } : undefined
          })
          held = { stamp, value }
          if (cached.size >= 256) cached.delete(cached.keys().next().value!)
          cached.set(path, held)
        }
        return { ...bot, lastMessage: await held.value }
      } catch { cached.delete(path); return bot }
    })))
  }
  return rows
}

const texts = new Map<string, { stamp: string; value: Promise<string> }>()
const fold = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()

export async function botSearch(paths: VaultPaths, bots: Bot[], query: string): Promise<string[]> {
  const needle = fold(query)
  if (!needle) return []
  const hits: string[] = []
  for (let offset = 0; offset < bots.length; offset += 8) {
    await Promise.all(bots.slice(offset, offset + 8).map(async bot => {
      if (!/^[\w-]+$/.test(bot.id)) return
      const path = join(paths.cache, 'bot-chats', `${bot.id}.jsonl`)
      try {
        const info = await stat(path)
        const stamp = `${info.mtimeMs}:${info.size}`
        let held = texts.get(path)
        if (!held || held.stamp !== stamp) {
          // A finite limit reads the whole transcript; the default keeps only the last 400 turns.
          const value = readBotTranscript(paths, bot.id, Number.MAX_SAFE_INTEGER).then(turns => turns.filter(turn => !turn.progress).map(turn => fold(turn.text)).join('\n'))
          held = { stamp, value }
          if (texts.size >= 256) texts.delete(texts.keys().next().value!)
          texts.set(path, held)
        }
        if ((await held.value).includes(needle)) hits.push(bot.id)
      } catch { texts.delete(path) }
    }))
  }
  return hits
}

const BOT_ID = /^[\w-]+$/

export async function botUpdate(paths: VaultPaths, id: unknown, patch: unknown, changed: () => void): Promise<BotDto> {
  if (typeof id !== 'string' || !BOT_ID.test(id)) throw new Error('no such comet')
  const bot = await updateBot(paths, id, patch as BotPatch)
  changed()
  return bot
}

const skippable = (error: unknown) => ['ENOENT', 'EISDIR'].includes((error as NodeJS.ErrnoException).code ?? '')

export async function botConversations(paths: VaultPaths, id: unknown): Promise<BotConversationDto[]> {
  if (typeof id !== 'string' || !BOT_ID.test(id)) return []
  const dir = join(paths.cache, 'bot-chats')
  let names: string[]
  try { names = await readdir(dir) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const archive = new RegExp(`^${id}\\.(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})\\.jsonl$`)
  const stamps = names.flatMap(name => archive.exec(name)?.[1] ?? []).sort().reverse()
  const rows: BotConversationDto[] = []
  for (let offset = 0; offset < stamps.length; offset += 8) {
    rows.push(...(await Promise.all(stamps.slice(offset, offset + 8).map(async stamp => {
      try { return [{ stamp, turns: countTurns(await readFile(join(dir, `${id}.${stamp}.jsonl`), 'utf8')) }] } catch (error) {
        if (skippable(error)) return []
        throw error
      }
    }))).flat())
  }
  return rows
}

function countTurns(raw: string): number {
  let turns = 0
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as { role?: unknown; text?: unknown; progress?: unknown } | null
      if (typeof row === 'object' && row !== null && (row.role === 'user' || row.role === 'assistant') && typeof row.text === 'string' && row.progress !== true) turns++
    } catch { /* a corrupt line is not a turn */ }
  }
  return turns
}
