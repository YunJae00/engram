import { appendFile, mkdir, readFile, stat, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { VaultPaths } from './vault.js'
import { forgetBotMemory } from './bot-memory.js'
import { isSchedule, type Schedule } from './schedule.js'
import { renameWithRetry } from './rename-with-retry.js'
import { botPatchError } from './bot-fields.js'
export { AVATAR_RANGES } from './bot-fields.js'

// A task is the work a person repeats, saved on the comet that owns it and run with one click.
export interface BotTask {
  id: string
  name: string
  goal: string
  lastRunAt?: string
  // A standing task: without a procedure its goal is said as a turn; sends still wait for the person's OK.
  schedule?: Schedule
  routineId?: string
  // Run only when this read-only listing shows items not in `seen` from the last run.
  watch?: TaskWatch
  seen?: string[]
  // The conversation a repeating request keeps answering in.
  chat?: string
  paused?: true
}

export interface TaskWatch { tool: string; args: Record<string, unknown> }

export interface Bot {
  id: string
  name: string
  purpose: string
  createdAt: string
  webSites?: { origin: string; visits: number }[]
  tasks?: BotTask[]
  // Asks the person refused to make standing, by ask key: offered once.
  declined?: string[]
  avatar?: BotAvatar
  label?: string
  // Exactly one stored bot holds it whenever any bot exists.
  primary?: true
  hidden?: true
  notify?: 'all' | 'attention' | 'off'
  skills?: string[]
  templateId?: string
  updatedAt?: string
}

export type BotAvatar = { body: number; face: number; accessory: number; palette: number } | { image: string }
export type BotPatch = Partial<Pick<Bot, 'name' | 'purpose' | 'avatar' | 'label' | 'hidden' | 'notify' | 'skills' | 'templateId'>> & { primary?: boolean }

// How a checked answer was checked: verdicts with their basis, sources read, and the confirmed record.
export interface TurnEvidence {
  checks: { requirement: string; status: 'pass' | 'fail' | 'unknown'; basis: string }[]
  grounding: { status: 'pass' | 'fail' | 'unknown'; basis: string }
  sources: string[]
  record?: { confirmed: number; checked: number }
}

export interface BotTurn {
  role: 'user' | 'assistant'
  text: string
  progress?: boolean
  work?: string[]
  at: string
  attachments?: string[]
  evidence?: TurnEvidence
  // Said by a kept schedule at its time, not typed then.
  scheduled?: boolean
}

export interface BotSuggestion {
  name: string
  purpose: string
  reason: string
}

const BOTS_FILE = 'bots.json'
const CHAT_DIR = 'bot-chats'
// A conversation is a working surface; old turns fall off the top.
const TRANSCRIPT_CAP = 400

function botsPath(paths: VaultPaths): string {
  return join(paths.cache, BOTS_FILE)
}

function chatPath(paths: VaultPaths, botId: string): string {
  // The id is generated here (crypto hex), never user text, so it is safe as a file name.
  return join(paths.cache, CHAT_DIR, `${botId}.jsonl`)
}

interface BotsFile {
  bots: Bot[]
  // Refused suggestion names: a decision about this vault, so kept beside the bots.
  dismissed: string[]
}

// Parsed bots.json as stored; entries and fields the code does not know ride along to the next write.
interface StoredBots { raw: Record<string, unknown>; bots: unknown[]; dismissed: unknown[] }

function isBot(entry: unknown): entry is Bot {
  return typeof (entry as Bot | null)?.id === 'string' && typeof (entry as Bot).name === 'string'
}

async function readBotsBytes(paths: VaultPaths): Promise<Buffer | undefined> {
  try { return await readFile(botsPath(paths)) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseBots(bytes: Buffer | undefined): StoredBots | undefined {
  if (!bytes) return { raw: {}, bots: [], dismissed: [] }
  let raw: unknown
  // fatal: invalid UTF-8 is corrupt, never silently replaced with U+FFFD and rewritten.
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)) } catch { return undefined }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const { bots, dismissed = [] } = raw as { bots?: unknown; dismissed?: unknown }
  return Array.isArray(bots) && Array.isArray(dismissed) ? { raw: raw as Record<string, unknown>, bots, dismissed } : undefined
}

async function readBotsFile(paths: VaultPaths): Promise<BotsFile> {
  const stored = parseBots(await readBotsBytes(paths).catch(() => Buffer.alloc(0)))
  return { bots: stored?.bots.filter(isBot) ?? [], dismissed: stored?.dismissed.filter((n): n is string => typeof n === 'string') ?? [] }
}

// Never returns empty for a file that exists: a write after that would erase it.
async function readForWrite(paths: VaultPaths): Promise<StoredBots> {
  const bytes = await readBotsBytes(paths)
  const stored = parseBots(bytes)
  if (stored) return stored
  const target = botsPath(paths)
  const copy = `${target}.corrupt-${createHash('sha256').update(bytes!).digest('hex').slice(0, 16)}`
  if (!(await readFile(copy).catch(() => undefined))?.equals(bytes!)) {
    const scratch = `${target}.${process.pid}.copy.tmp`
    await writeFile(scratch, bytes!)
    await renameWithRetry(scratch, copy)
  }
  throw new Error(`bots.json could not be read and was left as is; a copy is kept at ${copy}`)
}

async function writeBotsFile(paths: VaultPaths, file: Record<string, unknown>): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  // Scratch + rename: a reader mid-write sees the old file whole.
  const target = botsPath(paths)
  const scratch = `${target}.${process.pid}.tmp`
  await writeFile(scratch, JSON.stringify(file, null, 2))
  await renameWithRetry(scratch, target)
}

// Each change is read-then-write; one chain per file keeps interleaved changes from losing one side.
const queues = new Map<string, Promise<unknown>>()

function serialized<T>(paths: VaultPaths, work: () => Promise<T>, key = botsPath(paths)): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.then(() => undefined, () => undefined)
  queues.set(key, settled)
  void settled.then(() => { if (queues.get(key) === settled) queues.delete(key) })
  return next
}

export async function loadBots(paths: VaultPaths): Promise<Bot[]> {
  return (await readBotsFile(paths)).bots
}

export function recordBotSites(paths: VaultPaths, botId: string, urls: string[]): Promise<void> {
  const origins = urls.flatMap(value => {
    try { const url = new URL(value); return /^https?:$/.test(url.protocol) && !url.username && !url.password ? [url.origin] : [] } catch { return [] }
  })
  if (!origins.length) return Promise.resolve()
  return mutateBots(paths, bots => {
    const bot = bots.find(one => one.id === botId)
    if (!bot) return
    const counts = new Map((bot.webSites ?? []).map(site => [site.origin, site.visits]))
    for (const origin of origins) counts.set(origin, (counts.get(origin) ?? 0) + 1)
    bot.webSites = [...counts].map(([origin, visits]) => ({ origin, visits })).sort((a, b) => b.visits - a.visits).slice(0, 8)
  })
}

// Read, change, write as one turn of the queue, or concurrent changes drop each other.
function mutateBots<T>(paths: VaultPaths, work: (bots: Bot[]) => T): Promise<T> {
  return serialized(paths, async () => {
    const stored = await readForWrite(paths)
    const bots = stored.bots.filter(isBot)
    const known = new Set<unknown>(bots)
    const out = work(bots)
    const kept = stored.bots.filter((entry) => !known.has(entry) || bots.includes(entry as Bot))
    await writeBotsFile(paths, { ...stored.raw, bots: [...kept, ...bots.filter((bot) => !known.has(bot))], dismissed: stored.dismissed })
    return out
  })
}

// A refused name is stored as shown, and shown names are short.
const SUGGESTION_NAME_CAP = 80

// The name the person saw and refused is the key, compared like "already have this bot".
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
    const stored = await readForWrite(paths)
    if (stored.dismissed.includes(key)) return
    await writeBotsFile(paths, { ...stored.raw, bots: stored.bots, dismissed: [...stored.dismissed, key] })
  })
}

// A comet made with one press carries this name until its first message names it.
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
  const purpose = (input.purpose ?? '').trim().slice(0, 2000)
  if (!name) throw new Error('a bot needs a name')
  const bot: Bot = {
    id: `bot-${now.getTime().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
    name,
    purpose,
    createdAt: now.toISOString(),
    updatedAt: new Date().toISOString(),
  }
  await mutateBots(paths, (bots) => {
    bots.push(bot)
    if (!bots.some((b) => b.primary === true)) bot.primary = true
  })
  return bot
}

export async function renameBot(paths: VaultPaths, id: string, name: string): Promise<void> {
  const next = name.trim().slice(0, 60)
  if (!next) return
  await mutateBots(paths, (bots) => {
    const bot = bots.find((b) => b.id === id)
    if (bot) bot.name = next
  })
}

export async function deleteBot(paths: VaultPaths, id: string, opts: { undoCreate?: Bot } = {}): Promise<void> {
  await serialized(paths, async () => {
    const stored = await readForWrite(paths), same = stored.bots.filter((b): b is Record<string, unknown> => typeof b === 'object' && b !== null && (b as Bot).id === id)
    if (same.length === 0) return
    const [undo, one] = [opts.undoCreate, same[0]], undoing = !!undo && same.length === 1 && one!.createdAt === undo.createdAt && one!.updatedAt === undo.updatedAt && Object.keys(one!).every((k) => ['id', 'name', 'purpose', 'createdAt', 'updatedAt', 'primary'].includes(k))
    if (same.some((b) => b.primary === true) && !undoing) throw new Error('the primary comet cannot be deleted; make another comet primary first')
    await writeBotsFile(paths, { ...stored.raw, bots: stored.bots.filter((b) => !same.includes(b as Record<string, unknown>)), dismissed: stored.dismissed })
  })
  // Its memory of the person goes with it; the transcript stays on disk until a vault reset.
  await forgetBotMemory(paths, id)
}

export async function addBotTask(
  paths: VaultPaths,
  botId: string,
  input: { name: string; goal: string; schedule?: Schedule; routineId?: string; watch?: TaskWatch },
  now: Date = new Date(),
): Promise<BotTask> {
  const name = input.name.trim().slice(0, 60)
  const goal = input.goal.trim().slice(0, 500)
  if (!name) throw new Error('a task needs a name')
  if (!goal) throw new Error('a task needs a goal — what should it do?')
  if (input.schedule !== undefined && !isSchedule(input.schedule)) throw new Error('a schedule needs days, an hour and a minute')
  const task: BotTask = {
    id: `task-${now.getTime().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
    name,
    goal,
    ...(input.schedule ? { schedule: input.schedule } : {}),
    ...(input.routineId ? { routineId: input.routineId } : {}),
    ...(input.watch ? { watch: input.watch } : {}),
  }
  await mutateBots(paths, (bots) => {
    const bot = bots.find((b) => b.id === botId)
    if (!bot) throw new Error('no such comet')
    bot.tasks = [...(bot.tasks ?? []), task]
  })
  return task
}

export async function declineStanding(paths: VaultPaths, botId: string, key: string): Promise<void> {
  if (!key) return
  await mutateBots(paths, (bots) => {
    const bot = bots.find((b) => b.id === botId)
    if (bot) bot.declined = [...new Set([...(bot.declined ?? []), key])].slice(-100)
  })
}

export async function removeBotTask(paths: VaultPaths, botId: string, taskId: string): Promise<void> {
  await mutateBots(paths, (bots) => {
    const bot = bots.find((b) => b.id === botId)
    if (bot) bot.tasks = (bot.tasks ?? []).filter((x) => x.id !== taskId)
  })
}

export async function markBotTaskRun(paths: VaultPaths, botId: string, taskId: string, now: Date = new Date(), kept: { seen?: string[]; chat?: string } = {}): Promise<void> {
  await mutateBots(paths, (bots) => {
    const task = bots.find((b) => b.id === botId)?.tasks?.find((x) => x.id === taskId)
    if (!task) return
    task.lastRunAt = now.toISOString()
    if (kept.seen) task.seen = kept.seen.slice(0, 200)
    if (kept.chat) task.chat = kept.chat
  })
}

// One appended line per turn; compacted only once well past the cap.
const TRANSCRIPT_COMPACT_BYTES = 2_000_000
const compactAt = new Map<string, number>()

export async function updateBot(paths: VaultPaths, id: string, patch: BotPatch): Promise<Bot> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new Error('a bot change must be an object')
  // One read of the caller's object; nested values are detached so nothing changes while queued.
  const copy: BotPatch = { ...patch }
  if (copy.avatar && typeof copy.avatar === 'object' && !Array.isArray(copy.avatar)) copy.avatar = { ...copy.avatar }
  if (Array.isArray(copy.skills)) copy.skills = [...copy.skills]
  const error = botPatchError(copy)
  if (error) throw new Error(error)
  if (copy.name !== undefined) copy.name = copy.name.trim().slice(0, 60)
  if (copy.purpose !== undefined) copy.purpose = copy.purpose.trim().slice(0, 2000)
  return mutateBots(paths, (bots) => {
    const bot = bots.find((b) => b.id === id)
    if (!bot) throw new Error('no such comet')
    if (bot.primary && Object.hasOwn(copy, 'primary') && copy.primary !== true) throw new Error('the primary comet stays primary until another one is made primary')
    if (copy.primary) for (const other of bots) if (other !== bot) delete other.primary
    const fields = bot as unknown as Record<string, unknown>
    for (const [key, value] of Object.entries(copy)) {
      if (value === undefined || value === false) delete fields[key]
      else fields[key] = value
    }
    bot.updatedAt = new Date().toISOString()
    return { ...bot }
  })
}

export function appendBotTurn(paths: VaultPaths, botId: string, turn: BotTurn): Promise<void> {
  const file = chatPath(paths, botId)
  return serialized(paths, async () => {
    await mkdir(join(paths.cache, CHAT_DIR), { recursive: true })
    await appendFile(file, `${JSON.stringify(turn)}\n`)
    const size = await stat(file).then(s => s.size, () => 0)
    if (size < (compactAt.get(file) ?? TRANSCRIPT_COMPACT_BYTES)) return
    const rows = await readBotTranscript(paths, botId, TRANSCRIPT_CAP)
    const data = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`
    const scratch = `${file}.${process.pid}.tmp`
    await writeFile(scratch, data)
    await renameWithRetry(scratch, file)
    if (compactAt.size >= 256) compactAt.delete(compactAt.keys().next().value!)
    compactAt.set(file, Buffer.byteLength(data) + TRANSCRIPT_COMPACT_BYTES)
  }, file)
}

// A fresh start: the transcript is put away beside the live file, nothing deleted.
export function archiveBotTranscript(paths: VaultPaths, botId: string, now: Date = new Date()): Promise<void> {
  const live = chatPath(paths, botId)
  return serialized(paths, async () => {
    try {
      const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
      await rename(live, join(paths.cache, CHAT_DIR, `${botId}.${stamp}.jsonl`))
      compactAt.delete(live)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }, live)
}

export async function readBotTranscript(paths: VaultPaths, botId: string, limit = TRANSCRIPT_CAP): Promise<BotTurn[]> {
  try {
    const raw = await readFile(chatPath(paths, botId), 'utf8')
    const rows: BotTurn[] = []
    let end = raw.length
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : TRANSCRIPT_CAP
    while (end > 0 && rows.length < count) {
      const start = raw.lastIndexOf('\n', end - 1)
      const line = raw.slice(start + 1, end)
      end = start
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as BotTurn
        if ((parsed?.role === 'user' || parsed?.role === 'assistant') && typeof parsed?.text === 'string')
          rows.push(parsed)
      } catch {
        // one corrupt line must not cost the conversation
      }
    }
    return rows.reverse()
  } catch {
    return []
  }
}

// What bots would this vault want, read from its busiest folders; deterministic so it does not read as noise.
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
