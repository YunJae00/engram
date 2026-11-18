import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readBotTranscript, type Bot, type VaultPaths } from 'core'
import { withoutReplies } from 'core/src/agent-history'
import { withoutResidue } from 'core/src/bot-memory'
import { readLastBotTurn } from 'core/src/bot-transcript'
import { updateBot, type BotPatch } from 'core/src/bots'
import type { BotConversationDto, BotDto, BotSearchHit } from '../shared/types.js'

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
          const value = readLastBotTurn(paths, bot.id).then(turn =>
            turn ? { role: turn.role, text: withoutReplies(turn.text).replace(/\s+/g, ' ').trim().slice(0, 200), at: turn.at } : undefined)
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

const texts = new Map<string, { stamp: string; value: Promise<{ plain: string; folded: string }[]> }>()
const flat = (text: string) => text.replace(/\s+/g, ' ').trim()
const fold = (text: string) => flat(text).toLocaleLowerCase()
const SENTENCE_END = /(?<=[.!?。])\s+|\s(?:-{3,}|[-*]|```)\s/

export async function botSearch(paths: VaultPaths, bots: Bot[], query: string): Promise<BotSearchHit[]> {
  const needle = fold(query)
  if (!needle) return []
  const hits: BotSearchHit[] = []
  for (let offset = 0; offset < bots.length; offset += 8) {
    await Promise.all(bots.slice(offset, offset + 8).map(async bot => {
      if (!/^[\w-]+$/.test(bot.id)) return
      const path = join(paths.cache, 'bot-chats', `${bot.id}.jsonl`)
      try {
        const info = await stat(path)
        const stamp = `${info.mtimeMs}:${info.size}`
        let held = texts.get(path)
        if (!held || held.stamp !== stamp) {
          const value = readBotTranscript(paths, bot.id, Number.MAX_SAFE_INTEGER).then(turns => turns.filter(turn => !turn.progress).map(turn => ({ plain: flat(turn.text), folded: fold(turn.text) })))
          held = { stamp, value }
          if (texts.size >= 256) texts.delete(texts.keys().next().value!)
          texts.set(path, held)
        }
        let bare: string | undefined
        let excerpt: string | undefined
        for (const turn of await held.value) {
          const at = turn.folded.indexOf(needle)
          if (at < 0) continue
          const end = at + needle.length
          const before = turn.plain.slice(0, at).split(SENTENCE_END).pop() ?? ''
          const after = turn.plain.slice(end, end + 120).split(SENTENCE_END)[0] ?? ''
          const sentence = withoutResidue(before + turn.plain.slice(at, end) + after).text
          const hit = sentence.toLocaleLowerCase().indexOf(needle)
          if (hit < 0) { bare ??= (at > 8 ? '…' : '') + turn.plain.slice(Math.max(0, at - 8), end); continue }
          const from = Math.max(0, hit - 8)
          excerpt = (from ? '…' : '') + sentence.slice(from, hit + needle.length + 120)
          break
        }
        excerpt ??= bare
        if (excerpt !== undefined) hits.push({ id: bot.id, excerpt })
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
    } catch {}
  }
  return turns
}
