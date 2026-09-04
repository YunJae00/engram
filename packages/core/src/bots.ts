import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'
import { forgetBotMemory } from './bot-memory.js'
import { isSchedule, type Schedule } from './schedule.js'

// Bots are named colleagues inside the vault: each carries a charter (what it
// is for), keeps its own conversation, and can dispatch errands. The heart of
// one is a paragraph of intent — everything heavier (retrieval, inference,
// browsing) is borrowed from the host at answer time, which is why a bot is
// cheap enough to make one per concern.

// A task is the work a person repeats: "gather last week's decisions",
// "draft the deploy notice". Saved on the comet that owns it, run with one
// click — an errand is the engine, this is the thing you actually keep.
export interface BotTask {
  id: string
  name: string
  goal: string
  lastRunAt?: string
  // A task that stands: the procedure it replays and when. Only a
  // read-only procedure with no blanks is ever given one - anything that
  // posts, or needs words, stays a press away.
  schedule?: Schedule
  routineId?: string
}

export interface Bot {
  id: string
  name: string
  purpose: string
  createdAt: string
  tasks?: BotTask[]
  // Asks the person refused to make standing, by ask key: offered once, not
  // every third morning.
  declined?: string[]
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

interface BotsFile {
  bots: Bot[]
  // Suggestions the person turned down, by lowercased name. Kept beside the
  // bots because a refusal is a decision about this vault, not this machine —
  // it must outlive a reinstall and must not follow the person to another vault.
  dismissed: string[]
}

async function readBotsFile(paths: VaultPaths): Promise<BotsFile> {
  try {
    const raw = JSON.parse(await readFile(botsPath(paths), 'utf8')) as Partial<BotsFile>
    return {
      bots: Array.isArray(raw.bots)
        ? raw.bots.filter((b) => typeof b?.id === 'string' && typeof b?.name === 'string')
        : [],
      dismissed: Array.isArray(raw.dismissed) ? raw.dismissed.filter((n): n is string => typeof n === 'string') : [],
    }
  } catch {
    return { bots: [], dismissed: [] }
  }
}

async function writeBotsFile(paths: VaultPaths, file: BotsFile): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  await writeFile(botsPath(paths), JSON.stringify(file, null, 2))
}

// Every change to the file is a read followed by a write, and two of those
// interleaved lose one side. One chain per file keeps them in order.
const queues = new Map<string, Promise<unknown>>()

function serialized<T>(paths: VaultPaths, work: () => Promise<T>): Promise<T> {
  const key = botsPath(paths)
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work)
  queues.set(key, next.catch(() => undefined))
  return next
}

export async function loadBots(paths: VaultPaths): Promise<Bot[]> {
  return (await readBotsFile(paths)).bots
}

function saveBots(paths: VaultPaths, bots: Bot[]): Promise<void> {
  return serialized(paths, async () => {
    const { dismissed } = await readBotsFile(paths)
    await writeBotsFile(paths, { bots, dismissed })
  })
}

// A refused name is stored as shown, and shown names are short.
const SUGGESTION_NAME_CAP = 80

// Suggestions carry no id; the name is what the person saw and refused, so it
// is the key — compared the same way "already have this bot" is.
function suggestionKey(name: string): string {
  return name.trim().toLowerCase()
}

export async function loadDismissedSuggestions(paths: VaultPaths): Promise<string[]> {
  return (await readBotsFile(paths)).dismissed
}

export function dismissBotSuggestion(paths: VaultPaths, name: string): Promise<void> {
  const key = suggestionKey(name).slice(0, SUGGESTION_NAME_CAP)
  if (!key) return Promise.resolve()
  return serialized(paths, async () => {
    const file = await readBotsFile(paths)
    if (file.dismissed.includes(key)) return
    await writeBotsFile(paths, { ...file, dismissed: [...file.dismissed, key] })
  })
}

// A comet made with one press carries this name until its first message
// names it.
export const UNTITLED_BOT_NAME = 'New comet'
const TITLE_CHARS = 40

export function titleFromMessage(message: string): string {
  const line = message.replace(/\s+/g, ' ').trim()
  const chars = Array.from(line)
  return (chars.length > TITLE_CHARS ? `${chars.slice(0, TITLE_CHARS).join('').trimEnd()}…` : line) || UNTITLED_BOT_NAME
}

export async function createBot(
  paths: VaultPaths,
  input: { name: string; purpose?: string },
  now: Date = new Date(),
): Promise<Bot> {
  const name = input.name.trim().slice(0, 60)
  // The charter is optional: most comets are a conversation, not a role.
  const purpose = (input.purpose ?? '').trim().slice(0, 500)
  if (!name) throw new Error('a bot needs a name')
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

export async function renameBot(paths: VaultPaths, id: string, name: string): Promise<void> {
  const next = name.trim().slice(0, 60)
  if (!next) return
  const bots = await loadBots(paths)
  const bot = bots.find((b) => b.id === id)
  if (!bot) return
  bot.name = next
  await saveBots(paths, bots)
}

export async function deleteBot(paths: VaultPaths, id: string): Promise<void> {
  const bots = await loadBots(paths)
  await saveBots(paths, bots.filter((b) => b.id !== id))
  // What it remembered of the person goes with it: that was its reading,
  // and deleting the comet is the person's word on it.
  await forgetBotMemory(paths, id)
  // The transcript file stays on disk (cheap, and deleting user words should
  // never ride silently on another action); recreating the bot id is
  // impossible, so it is unreachable garbage a vault reset clears.
}

export async function addBotTask(
  paths: VaultPaths,
  botId: string,
  input: { name: string; goal: string; schedule?: Schedule; routineId?: string },
  now: Date = new Date(),
): Promise<BotTask> {
  const name = input.name.trim().slice(0, 60)
  const goal = input.goal.trim().slice(0, 500)
  if (!name) throw new Error('a task needs a name')
  if (!goal) throw new Error('a task needs a goal — what should it do?')
  if (input.schedule !== undefined && !isSchedule(input.schedule)) throw new Error('a schedule needs days, an hour and a minute')
  if (input.schedule && !input.routineId) throw new Error('a standing task needs a procedure to replay')
  const bots = await loadBots(paths)
  const bot = bots.find((b) => b.id === botId)
  if (!bot) throw new Error('no such comet')
  const task: BotTask = {
    id: `task-${now.getTime().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
    name,
    goal,
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.routineId ? { routineId: input.routineId } : {}),
  }
  bot.tasks = [...(bot.tasks ?? []), task]
  await saveBots(paths, bots)
  return task
}

export async function declineStanding(paths: VaultPaths, botId: string, key: string): Promise<void> {
  const bots = await loadBots(paths)
  const bot = bots.find((b) => b.id === botId)
  if (!bot || !key) return
  bot.declined = [...new Set([...(bot.declined ?? []), key])].slice(-100)
  await saveBots(paths, bots)
}

export async function removeBotTask(paths: VaultPaths, botId: string, taskId: string): Promise<void> {
  const bots = await loadBots(paths)
  const bot = bots.find((b) => b.id === botId)
  if (!bot) return
  bot.tasks = (bot.tasks ?? []).filter((x) => x.id !== taskId)
  await saveBots(paths, bots)
}

export async function markBotTaskRun(paths: VaultPaths, botId: string, taskId: string, now: Date = new Date()): Promise<void> {
  const bots = await loadBots(paths)
  const task = bots.find((b) => b.id === botId)?.tasks?.find((x) => x.id === taskId)
  if (!task) return
  task.lastRunAt = now.toISOString()
  await saveBots(paths, bots)
}

export async function appendBotTurn(paths: VaultPaths, botId: string, turn: BotTurn): Promise<void> {
  await mkdir(join(paths.cache, CHAT_DIR), { recursive: true })
  const rows = await readBotTranscript(paths, botId, TRANSCRIPT_CAP - 1)
  const next = [...rows, turn].slice(-TRANSCRIPT_CAP)
  await writeFile(chatPath(paths, botId), `${next.map((row) => JSON.stringify(row)).join('\n')}\n`)
}

// A fresh start: the transcript so far is put away beside the live file
// (nothing a person said is deleted), and the conversation begins empty.
export async function archiveBotTranscript(paths: VaultPaths, botId: string, now: Date = new Date()): Promise<void> {
  const live = chatPath(paths, botId)
  try {
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    await rename(live, join(paths.cache, CHAT_DIR, `${botId}.${stamp}.jsonl`))
  } catch {
    // Nothing said yet: nothing to put away.
  }
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
  dismissedNames: string[] = [],
): BotSuggestion[] {
  // A refused suggestion counts as taken: it must not be offered again.
  const taken = new Set([...existingNames, ...dismissedNames].map(suggestionKey))
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
