import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readBotTranscript, type BotTurn } from './bots.js'
import type { VaultPaths } from './vault.js'

const BOT_ID = /^[\w-]+$/
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/
const PAGE_CAP = 400

function checkId(botId: unknown): asserts botId is string {
  if (typeof botId !== 'string' || !BOT_ID.test(botId)) throw new Error('no such comet')
}

function checkPage(before: unknown, limit: unknown): number {
  if (!Number.isSafeInteger(before) || (before as number) < 0) throw new Error('bad page cursor')
  if (limit === undefined) return PAGE_CAP
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > PAGE_CAP) throw new Error('bad page size')
  return limit as number
}

function parseTurns(raw: string): BotTurn[] {
  const rows: BotTurn[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line) as BotTurn
      if ((parsed?.role === 'user' || parsed?.role === 'assistant') && typeof parsed?.text === 'string') rows.push(parsed)
    } catch {
      // one corrupt line must not cost the conversation
    }
  }
  return rows
}

// `before` counts valid turns from the newest end, so cursors survive appends and compaction.
export async function readBotTranscriptPage(paths: VaultPaths, botId: unknown, before: unknown, limit?: unknown): Promise<BotTurn[]> {
  checkId(botId)
  const size = checkPage(before, limit)
  const skip = before as number
  const rows = await readBotTranscript(paths, botId, skip + size)
  return rows.slice(0, Math.max(0, rows.length - skip))
}

export async function readArchivedTranscript(paths: VaultPaths, botId: unknown, stamp: unknown, before: unknown = 0, limit?: unknown): Promise<BotTurn[]> {
  checkId(botId)
  if (typeof stamp !== 'string' || !STAMP.test(stamp)) throw new Error('bad conversation stamp')
  const size = checkPage(before, limit)
  const skip = before as number
  let raw: string
  try {
    raw = await readFile(join(paths.cache, 'bot-chats', `${botId}.${stamp}.jsonl`), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('no such conversation')
    throw err
  }
  const rows = parseTurns(raw)
  const end = Math.max(0, rows.length - skip)
  return rows.slice(Math.max(0, end - size), end)
}
