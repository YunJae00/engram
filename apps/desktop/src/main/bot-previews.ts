import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readBotTranscript, type Bot, type VaultPaths } from 'core'
import type { BotDto } from '../shared/types.js'

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
