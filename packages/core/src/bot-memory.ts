import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { namesSubject } from './search-template.js'
import { secretsIn } from './secrets.js'
import type { VaultPaths } from './vault.js'

// What a comet remembers about the person across every conversation: short
// facts, each with the day it was first written and the day it was last said
// again. The vault is the person's memory; this is the comet's reading of the
// person, kept apart from it, small, and theirs to delete line by line.

export interface BotFact {
  id: string
  text: string
  // First written - the order facts are rendered in, so the prompt head only
  // ever grows at the end and the model's prefix cache keeps working.
  at: string
  // Last said again - the clock the fact fades by.
  touchedAt: string
}

export interface BotMemoryFile {
  facts: BotFact[]
  turns: number
}

const MEMORY_DIR = 'bot-memory'
// A fact said a month ago weighs half of one said today; one never said
// again fades out of the prompt in a few months and stays on disk.
export const HALF_LIFE_DAYS = 30
export const FACT_CHARS = 160
// The block is capped by characters, not lines, so its share of the prompt
// holds whatever the notes look like: this is roughly one observation.
export const MEMORY_CHARS = 800
export const MEMORY_LINES = 12
export const DISK_CAP = 200
const DAY_MS = 86_400_000

function memoryPath(paths: VaultPaths, botId: string): string {
  return join(paths.cache, MEMORY_DIR, `${botId}.json`)
}

const queues = new Map<string, Promise<unknown>>()
function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const next = (queues.get(key) ?? Promise.resolve()).then(work, work)
  queues.set(key, next.catch(() => undefined))
  return next
}

export async function loadBotMemory(paths: VaultPaths, botId: string): Promise<BotMemoryFile> {
  try {
    const raw = JSON.parse(await readFile(memoryPath(paths, botId), 'utf8')) as Partial<BotMemoryFile>
    const facts = Array.isArray(raw.facts)
      ? raw.facts.filter(
          (f): f is BotFact =>
            typeof f?.id === 'string' && typeof f?.text === 'string' && typeof f?.at === 'string' && typeof f?.touchedAt === 'string',
        )
      : []
    return { facts, turns: typeof raw.turns === 'number' ? raw.turns : 0 }
  } catch {
    return { facts: [], turns: 0 }
  }
}

async function saveBotMemory(paths: VaultPaths, botId: string, file: BotMemoryFile): Promise<void> {
  await mkdir(join(paths.cache, MEMORY_DIR), { recursive: true })
  await writeFile(memoryPath(paths, botId), JSON.stringify(file, null, 2))
}

// Greetings, acknowledgements and requests that name nothing carry nothing
// worth keeping; neither does a turn the comet could not answer.
const TRIVIAL = /^(hi|hey|hello|thanks?|thank you|thx|ok|okay|k|cool|nice|great|yes|yep|no|nope|sure|bye|고마워요?|감사합니다|ㅇㅋ|오케이|응|네|넵|아니요?|알겠어요?|안녕하?세요?|잘가|수고해?요?)[\s!.~^ㅋㅎ]*$/i

export function memorableTurn(message: string, answer: string): boolean {
  const said = message.trim()
  if (said.length < 6 || !answer.trim()) return false
  if (TRIVIAL.test(said)) return false
  return namesSubject(said)
}

export function normalizeFact(text: string): string {
  return text
    .replace(/^[-*•\d.)\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。!]+$/, '')
    .slice(0, FACT_CHARS)
}

// The model's lines, kept only where they are facts: not NONE, not a
// restatement of something kept, never a secret.
export function parseFactLines(raw: string, known: readonly string[]): string[] {
  const seen = new Set(known.map((k) => normalizeFact(k).toLowerCase()))
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const fact = normalizeFact(line)
    if (!fact || /^none$/i.test(fact) || fact.length < 4) continue
    if (secretsIn(fact).length > 0) continue
    const key = fact.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(fact)
  }
  return out
}

export function factScore(fact: BotFact, now: Date): number {
  const age = Math.max(0, now.getTime() - new Date(fact.touchedAt).getTime()) / DAY_MS
  return 0.5 ** (age / HALF_LIFE_DAYS)
}

export interface MemoryChange {
  added: number
  touched: number
}

// A fact said again is the same fact with a fresh clock, never a second line.
export function recordFacts(paths: VaultPaths, botId: string, lines: string[], now = new Date()): Promise<MemoryChange> {
  return serialized(memoryPath(paths, botId), async () => {
    const file = await loadBotMemory(paths, botId)
    const stamp = now.toISOString()
    let added = 0
    let touched = 0
    for (const line of lines) {
      const text = normalizeFact(line)
      if (!text) continue
      const same = file.facts.find((f) => normalizeFact(f.text).toLowerCase() === text.toLowerCase())
      if (same) {
        same.touchedAt = stamp
        touched++
      } else {
        file.facts.push({ id: `f-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`, text, at: stamp, touchedAt: stamp })
        added++
      }
    }
    file.turns++
    if (file.facts.length > DISK_CAP)
      file.facts = [...file.facts].sort((a, b) => factScore(b, now) - factScore(a, now)).slice(0, DISK_CAP)
    await saveBotMemory(paths, botId, file)
    return { added, touched }
  })
}

export async function forgetFact(paths: VaultPaths, botId: string, factId: string): Promise<void> {
  await serialized(memoryPath(paths, botId), async () => {
    const file = await loadBotMemory(paths, botId)
    file.facts = file.facts.filter((f) => f.id !== factId)
    await saveBotMemory(paths, botId, file)
  })
}

export async function forgetBotMemory(paths: VaultPaths, botId: string): Promise<void> {
  await rm(memoryPath(paths, botId), { force: true }).catch(() => undefined)
}

// The facts that ride in the prompt: the freshest within the budget, rendered
// in the order they were first written.
export function selectForPrompt(file: BotMemoryFile, now = new Date()): BotFact[] {
  const ranked = [...file.facts].sort((a, b) => factScore(b, now) - factScore(a, now))
  const chosen: BotFact[] = []
  let chars = 0
  for (const fact of ranked) {
    if (chosen.length >= MEMORY_LINES || chars + fact.text.length > MEMORY_CHARS) break
    chosen.push(fact)
    chars += fact.text.length
  }
  return chosen.sort((a, b) => a.at.localeCompare(b.at))
}

export function renderMemory(file: BotMemoryFile, now = new Date()): string {
  const chosen = selectForPrompt(file, now)
  if (chosen.length === 0) return ''
  return chosen.map((f) => `- (${f.at.slice(0, 10)}) ${f.text}`).join('\n')
}

// The one prompt of the feature. Short on purpose: the model that reads it
// answers in a few hundred tokens and must not be asked to classify, diff
// or copy - only to notice what is worth keeping.
export const REMEMBER_TOKENS = 120
export function rememberPrompt(exchange: { user: string; answer: string }, known: readonly string[]): string {
  return [
    'JOB: COMET-REMEMBER',
    'You keep short notes about the person you assist. From the exchange below, write only what is worth remembering in later, unrelated conversations: who they are, how they like to be helped, ongoing work, decisions, dates.',
    'Rules: at most 3 lines, each a complete short sentence in their language, each beginning with "- ". Nothing that is already in "Already kept". Nothing about this one request itself. No passwords or keys. If nothing is worth keeping, write only: NONE',
    '',
    'Already kept:',
    ...(known.length ? known.map((k) => `- ${k}`) : ['(nothing yet)']),
    '',
    `Person: ${exchange.user.slice(0, 600)}`,
    `You answered: ${exchange.answer.slice(0, 600)}`,
  ].join('\n')
}
