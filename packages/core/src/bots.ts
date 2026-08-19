import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'

// Bots are named colleagues inside the vault: each carries a charter (what it
// is for), keeps its own conversation, and can dispatch errands. The heart of
// one is a paragraph of intent — everything heavier (retrieval, inference,
// browsing) is borrowed from the host at answer time, which is why a bot is
// cheap enough to make one per concern.

export interface Bot {
  id: string
  name: string
  purpose: string
  createdAt: string
}

export interface BotTurn {
  role: 'user' | 'assistant'
  text: string
  at: string
}

export interface BotSuggestion {
  name: string
  purpose: string
  reason: string
}

const BOTS_FILE = 'bots.json'
const CHAT_DIR = 'bot-chats'
// A conversation is a working surface, not an archive — the vault is the
// archive. Old turns fall off the top.
const TRANSCRIPT_CAP = 400

function botsPath(paths: VaultPaths): string {
  return join(paths.cache, BOTS_FILE)
}

function chatPath(paths: VaultPaths, botId: string): string {
  // The id is generated here (crypto hex) — never user text — so it is safe
  // as a file name.
  return join(paths.cache, CHAT_DIR, `${botId}.jsonl`)
}

export async function loadBots(paths: VaultPaths): Promise<Bot[]> {
  try {
    const raw = JSON.parse(await readFile(botsPath(paths), 'utf8')) as { bots?: Bot[] }
    return Array.isArray(raw.bots) ? raw.bots.filter((b) => typeof b?.id === 'string' && typeof b?.name === 'string') : []
  } catch {
    return []
  }
}

async function saveBots(paths: VaultPaths, bots: Bot[]): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  await writeFile(botsPath(paths), JSON.stringify({ bots }, null, 2))
}

export async function createBot(
  paths: VaultPaths,
  input: { name: string; purpose: string },
  now: Date = new Date(),
): Promise<Bot> {
  const name = input.name.trim().slice(0, 60)
  const purpose = input.purpose.trim().slice(0, 500)
  if (!name) throw new Error('a bot needs a name')
  if (!purpose) throw new Error('a bot needs a purpose — what is it for?')
  const bots = await loadBots(paths)
  const bot: Bot = {
    id: `bot-${now.getTime().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
    name,
    purpose,
    createdAt: now.toISOString(),
  }
  await saveBots(paths, [...bots, bot])
  return bot
}

export async function deleteBot(paths: VaultPaths, id: string): Promise<void> {
  const bots = await loadBots(paths)
  await saveBots(paths, bots.filter((b) => b.id !== id))
  // The transcript file stays on disk (cheap, and deleting user words should
  // never ride silently on another action); recreating the bot id is
  // impossible, so it is unreachable garbage a vault reset clears.
}

export async function appendBotTurn(paths: VaultPaths, botId: string, turn: BotTurn): Promise<void> {
  await mkdir(join(paths.cache, CHAT_DIR), { recursive: true })
  const rows = await readBotTranscript(paths, botId, TRANSCRIPT_CAP - 1)
  const next = [...rows, turn].slice(-TRANSCRIPT_CAP)
  await writeFile(chatPath(paths, botId), `${next.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

export async function readBotTranscript(paths: VaultPaths, botId: string, limit = TRANSCRIPT_CAP): Promise<BotTurn[]> {
  try {
    const raw = await readFile(chatPath(paths, botId), 'utf8')
    const rows: BotTurn[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as BotTurn
        if ((parsed?.role === 'user' || parsed?.role === 'assistant') && typeof parsed?.text === 'string')
          rows.push(parsed)
      } catch {
        // one corrupt line must not cost the conversation
      }
    }
    return rows.slice(-limit)
  } catch {
    return []
  }
}

// What bots would this vault want? Read from what is actually in it: folders
// the user works in constantly deserve a resident colleague. Deterministic on
// purpose — a recommendation that changes every call reads as noise.
export function recommendBots(
  notes: { context?: string; title: string }[],
  existingNames: string[],
): BotSuggestion[] {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()))
  const byContext = new Map<string, number>()
  for (const note of notes) {
    const ctx = note.context?.trim()
    if (!ctx) continue
    byContext.set(ctx, (byContext.get(ctx) ?? 0) + 1)
  }
  const suggestions: BotSuggestion[] = []
  const ranked = [...byContext.entries()].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1])
  for (const [ctx, count] of ranked.slice(0, 2)) {
    const name = `${ctx} assistant`
    if (taken.has(name.toLowerCase())) continue
    suggestions.push({
      name,
      purpose: `Answers questions and keeps track of decisions in the user's "${ctx}" work, grounded in the memories filed there.`,
      reason: `${count} memories in "${ctx}"`,
    })
  }
  if (!taken.has('research scout')) {
    suggestions.push({
      name: 'Research scout',
      purpose:
        'Takes research goals, searches the memory first, browses the web in its own Chrome when the vault is not enough, and returns cited proposals for review.',
      reason: 'runs web errands',
    })
  }
  return suggestions.slice(0, 3)
}
