import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { generateNoteId } from './id.js'
import type { DecayLevel, Note, NoteFrontmatter, NoteStatus, TimelineMode } from './schema.js'
import { parseNote, serializeNote } from './schema.js'
import { verificationWindowDays } from './freshness.js'
import type { VaultPaths } from './vault.js'
import { renameWithRetry } from './rename-with-retry.js'

export function notePath(paths: VaultPaths, id: string): string {
  if (!id || id !== basename(id) || /[\\/\0]/.test(id) || id.includes('..')) {
    throw new Error(`unsafe note id: ${JSON.stringify(id)}`)
  }
  return join(paths.notes, `${id}.md`)
}

export async function readNote(paths: VaultPaths, id: string): Promise<Note> {
  return parseNote(await readFile(notePath(paths, id), 'utf8'))
}

export async function writeNote(paths: VaultPaths, note: Note): Promise<void> {
  const target = notePath(paths, note.front.id)
  const tmp = `${target}.tmp-${process.pid}`
  await writeFile(tmp, serializeNote(note))
  await renameWithRetry(tmp, target)
}

const RECALL_THROTTLE_MS = 60 * 60_000

export async function recordRecall(paths: VaultPaths, id: string, now: Date = new Date()): Promise<boolean> {
  const note = await readNote(paths, id)
  const last = note.front.last_recalled ? Date.parse(note.front.last_recalled) : 0
  if (now.getTime() - last < RECALL_THROTTLE_MS) return false
  note.front.last_recalled = now.toISOString()
  note.front.recall_count = (note.front.recall_count ?? 0) + 1
  await writeNote(paths, note)
  return true
}

export const WARMTH_HALF_LIFE_DAYS = 14
const WARMTH_CAP = 2.5

export function effectiveWarmth(warmth: { w: number; at: string } | undefined, now: Date): number {
  if (!warmth) return 0
  const days = Math.max(0, (now.getTime() - Date.parse(warmth.at)) / 86_400_000)
  return warmth.w * 0.5 ** (days / WARMTH_HALF_LIFE_DAYS)
}

export async function recordWarmth(paths: VaultPaths, id: string, add: number, now: Date = new Date()): Promise<void> {
  if (add <= 0) return
  const note = await readNote(paths, id)
  const carried = effectiveWarmth(note.front.warmth, now)
  const w = Math.min(WARMTH_CAP, carried + add * (1 - carried / WARMTH_CAP))
  note.front.warmth = { w: Math.round(w * 100) / 100, at: now.toISOString() }
  await writeNote(paths, note)
}

const CO_RECALL_CAP = 6
export const RECALL_LINK_HALF_LIFE_DAYS = 90

export function effectiveRecallWeight(link: { w: number; at: string }, now: Date): number {
  const days = Math.max(0, (now.getTime() - Date.parse(link.at)) / 86_400_000)
  return link.w * 0.5 ** (days / RECALL_LINK_HALF_LIFE_DAYS)
}

export async function recordCoRecall(paths: VaultPaths, ids: string[], now: Date = new Date()): Promise<void> {
  const group = [...new Set(ids)].slice(0, CO_RECALL_CAP)
  const notes = new Map<string, Note>()
  for (const id of group) {
    try {
      notes.set(id, await readNote(paths, id))
    } catch {
    }
  }
  const touched = new Set<string>()
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const a = notes.get(group[i]!)
      const b = notes.get(group[j]!)
      if (!a || !b) continue
      for (const [self, other] of [
        [a, b],
        [b, a],
      ] as const) {
        const links = { ...(self.front.recall_links ?? {}) }
        const prior = links[other.front.id]
        if (prior && now.getTime() - Date.parse(prior.at) < RECALL_THROTTLE_MS) continue
        const carried = prior ? effectiveRecallWeight(prior, now) : 0
        links[other.front.id] = { w: Math.round((carried + 1) * 100) / 100, at: now.toISOString() }
        self.front.recall_links = links
        touched.add(self.front.id)
      }
    }
  }
  for (const id of touched) await writeNote(paths, notes.get(id)!)
}

const LOAD_CHUNK = 32

export interface SkippedNote {
  file: string
  reason: string
}

export async function loadNotes(paths: VaultPaths, onSkip?: (skipped: SkippedNote) => void): Promise<Note[]> {
  let files: string[] = []
  try {
    files = await readdir(paths.notes)
  } catch {
    return []
  }
  const md = files.filter((f) => f.endsWith('.md')).sort()
  const notes: Note[] = []
  for (let i = 0; i < md.length; i += LOAD_CHUNK) {
    const chunk = md.slice(i, i + LOAD_CHUNK)
    const parsed = await Promise.all(
      chunk.map(async (file): Promise<Note | null> => {
        try {
          return parseNote(await readFile(join(paths.notes, file), 'utf8'))
        } catch (err) {
          onSkip?.({ file, reason: err instanceof Error ? err.message : String(err) })
          return null
        }
      }),
    )
    for (const note of parsed) if (note) notes.push(note)
  }
  return notes
}

export function filterByStatus(notes: Note[], status: NoteStatus): Note[] {
  return notes.filter((n) => n.front.status === status)
}

export interface CreateNoteInput {
  body: string
  id?: string
  type?: string
  status?: NoteStatus
  decay?: DecayLevel
  supersedes?: string[]
  derived_from?: string[]
  source?: string
  happened_at?: string
  timeline?: TimelineMode
  owner?: string
  verified_until?: string
  salience?: 'high'
  triggers?: string[]
  open_loop?: boolean
  due_at?: string
  origin?: 'user' | 'session'
  context?: string
}

function initialVerifiedUntil(decay: DecayLevel, now: Date): string | undefined {
  const days = verificationWindowDays(decay)
  if (days === null) return undefined
  return new Date(now.getTime() + days * 86_400_000).toISOString()
}

export async function createNote(
  paths: VaultPaths,
  input: CreateNoteInput,
  now: Date = new Date(),
): Promise<Note> {
  const decay = input.decay ?? 'slow'
  const front: NoteFrontmatter = {
    id: input.id ?? generateNoteId(now),
    type: input.type ?? 'note',
    status: input.status ?? 'current',
    supersedes: input.supersedes ?? [],
    derived_from: input.derived_from ?? [],
    source: input.source,
    decay,
    verified_until: input.verified_until ?? initialVerifiedUntil(decay, now),
    happened_at: input.happened_at,
    timeline: input.timeline ?? 'inferred',
    owner: input.owner,
    created: now.toISOString(),
    updated: now.toISOString(),
    salience: input.salience,
    triggers: input.triggers,
    open_loop: input.open_loop,
    due_at: input.due_at,
    origin: input.origin,
    context: input.context,
  }
  const note: Note = { front, body: input.body }
  await writeNote(paths, note)
  return note
}

async function transition(
  paths: VaultPaths,
  id: string,
  status: NoteStatus,
  now: Date,
): Promise<Note> {
  const note = await readNote(paths, id)
  note.front.status = status
  note.front.updated = now.toISOString()
  await writeNote(paths, note)
  return note
}

async function inheritedContext(paths: VaultPaths, ids: string[]): Promise<string | undefined> {
  const labels = new Set<string>()
  for (const id of ids) {
    const note = await readNote(paths, id).catch(() => null)
    labels.add(note?.front.context ?? '')
  }
  const only = labels.size === 1 ? [...labels][0] : undefined
  return only || undefined
}

export async function supersedeNote(
  paths: VaultPaths,
  oldIds: string[],
  input: CreateNoteInput,
  now: Date = new Date(),
): Promise<Note> {
  const context = input.context ?? (await inheritedContext(paths, oldIds))
  const replacement = await createNote(
    paths,
    { ...input, context, supersedes: [...new Set([...(input.supersedes ?? []), ...oldIds])] },
    now,
  )
  for (const oldId of oldIds) await transition(paths, oldId, 'superseded', now)
  return replacement
}

export async function disputeNotes(
  paths: VaultPaths,
  ids: string[],
  now: Date = new Date(),
): Promise<Note[]> {
  const out: Note[] = []
  for (const id of ids) out.push(await transition(paths, id, 'disputed', now))
  return out
}

export async function verifyNote(paths: VaultPaths, id: string, now: Date = new Date()): Promise<Note> {
  const note = await readNote(paths, id)
  note.front.verified_until = initialVerifiedUntil(note.front.decay, now)
  if (note.front.status === 'disputed') note.front.status = 'current'
  note.front.updated = now.toISOString()
  await writeNote(paths, note)
  return note
}

export async function unlinkNotes(
  paths: VaultPaths,
  fromId: string,
  toId: string,
  now: Date = new Date(),
): Promise<Note> {
  const note = await readNote(paths, fromId)
  if (!note.front.derived_from.includes(toId)) return note
  note.front.derived_from = note.front.derived_from.filter((id) => id !== toId)
  if (note.front.link_reasons) {
    delete note.front.link_reasons[toId]
    if (Object.keys(note.front.link_reasons).length === 0) note.front.link_reasons = undefined
  }
  note.front.updated = now.toISOString()
  await writeNote(paths, note)
  return note
}

export async function linkNotes(
  paths: VaultPaths,
  fromId: string,
  toId: string,
  reason: string,
  now: Date = new Date(),
): Promise<Note> {
  const note = await readNote(paths, fromId)
  if (fromId === toId || note.front.derived_from.includes(toId)) return note
  note.front.derived_from = [...note.front.derived_from, toId]
  note.front.link_reasons = { ...(note.front.link_reasons ?? {}), [toId]: reason }
  note.front.updated = now.toISOString()
  await writeNote(paths, note)
  return note
}

export async function retireNote(paths: VaultPaths, id: string, now: Date = new Date()): Promise<Note> {
  return transition(paths, id, 'superseded', now)
}

export async function mergeInto(
  paths: VaultPaths,
  sourceIds: string[],
  mergedBody: string,
  now: Date = new Date(),
): Promise<Note> {
  const first = await readNote(paths, sourceIds[0]!)
  return supersedeNote(
    paths,
    sourceIds,
    {
      body: mergedBody,
      type: first.front.type,
      decay: first.front.decay,
      derived_from: sourceIds,
    },
    now,
  )
}
