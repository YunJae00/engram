import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { forgetFactText, loadBotMemory, normalizeFact, PERSON_MEMORY, recordFacts } from './bot-memory.js'
import { renameWithRetry } from './rename-with-retry.js'
import { readNote, writeNote } from './notes.js'
import type { Note } from './schema.js'
import type { VaultPaths } from './vault.js'

// The profile every comet reads, shown as a note the person can open, edit and
// prune like any other. The note is their surface; the memory file keeps each
// line's clocks. A line deleted from the note is forgotten, a line added is
// learned, and what comets learn is written back.

export const PROFILE_NOTE_ID = 'n-person-profile'
export const PROFILE_TYPE = 'profile'
const INTRO = '# About me\n\nWhat Engram has learned about how you work. Every comet reads this; edit or delete any line.\n'

export function profileLines(body: string): string[] {
  return body.split('\n').filter((line) => /^\s*[-*]\s+\S/.test(line)).map(normalizeFact).filter(Boolean)
}

async function readProfile(paths: VaultPaths): Promise<Note | null> {
  try { return await readNote(paths, PROFILE_NOTE_ID) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

const key = (text: string) => normalizeFact(text).toLowerCase()
const queues = new Map<string, Promise<void>>()
export function syncPersonNote(paths: VaultPaths, now = new Date(), learned: string[] = [], forgotten: string[] = []): Promise<void> {
  const next = (queues.get(paths.cache) ?? Promise.resolve()).catch(() => undefined).then(() => sync(paths, now, learned, forgotten))
  queues.set(paths.cache, next)
  return next.finally(() => { if (queues.get(paths.cache) === next) queues.delete(paths.cache) })
}

async function sync(paths: VaultPaths, now: Date, learned: string[], forgotten: string[]): Promise<void> {
  const note = await readProfile(paths)
  const snapshot = join(paths.cache, 'person-note-lines.json')
  let previous: string[] = []
  try { previous = JSON.parse(await readFile(snapshot, 'utf8')) as string[] }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  if (!Array.isArray(previous) || previous.some(line => typeof line !== 'string')) throw new Error('Invalid profile snapshot')
  const removed = new Set(forgotten.map(key))
  const inNote = new Set(profileLines(note?.body ?? '').map(key))
  // Compare to what was actually published, not an editor-controlled timestamp.
  for (const line of previous) if (!inNote.has(key(line))) removed.add(key(line))
  for (const line of removed) await forgetFactText(paths, PERSON_MEMORY, line)
  const memory = await loadBotMemory(paths, PERSON_MEMORY)
  const known = new Set(memory.facts.map(f => key(f.text)))
  const additions = [...profileLines(note?.body ?? ''), ...learned].filter(line => !removed.has(key(line)) && !known.has(key(line)))
  if (additions.length) await recordFacts(paths, PERSON_MEMORY, additions, now)
  const facts = (await loadBotMemory(paths, PERSON_MEMORY)).facts.sort((a, b) => a.at.localeCompare(b.at))
  if (!note && !facts.length) return
  // Retain the person's prose and formatting; append only newly learned lines.
  let body = (note?.body ?? INTRO).split('\n').filter(line => !/^\s*[-*]\s+\S/.test(line) || !removed.has(key(line))).join('\n')
  const shown = new Set(profileLines(body).map(key))
  const fresh = facts.filter(fact => !shown.has(key(fact.text)))
  if (fresh.length) body = `${body.trimEnd()}\n\n${fresh.map(fact => `- ${fact.text}`).join('\n')}\n`
  const stamp = now.toISOString()
  if (!note || note.body !== body) await writeNote(paths, {
    front: note?.front ? { ...note.front, updated: stamp } : { id: PROFILE_NOTE_ID, type: PROFILE_TYPE, status: 'current', supersedes: [], derived_from: [], decay: 'evergreen', timeline: 'ignore', created: stamp, updated: stamp },
    body,
  })
  await mkdir(paths.cache, { recursive: true })
  const scratch = `${snapshot}.${process.pid}.tmp`
  await writeFile(scratch, JSON.stringify(profileLines(body)))
  await renameWithRetry(scratch, snapshot)
}
