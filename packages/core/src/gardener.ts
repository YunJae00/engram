import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readNote, writeNote } from './notes.js'
import { noteTitle } from './schema.js'
import type { Note } from './schema.js'
import type { VaultPaths } from './vault.js'

const SHELF_AFTER_MS = 90 * 86_400_000
const GARDEN_CAP = 20
const LEDGER = 'garden-ledger.jsonl'

export interface GardenEvent {
  at: string
  id: string
  title: string
  reason: 'never-recalled' | 'recall-cold'
}

export function gardenCandidates(notes: Note[], now: Date = new Date()): Note[] {
  const cutoff = now.getTime() - SHELF_AFTER_MS
  return notes
    .filter((note) => {
      const front = note.front
      if (front.status !== 'current' || front.type === 'hub' || front.open_loop === true) return false
      if (front.decay !== 'fast' && front.decay !== 'ephemeral') return false
      if (Date.parse(front.created) > cutoff) return false
      if (front.last_recalled !== undefined && Date.parse(front.last_recalled) > cutoff) return false
      return true
    })
    .sort((a, b) => (a.front.created < b.front.created ? -1 : 1))
    .slice(0, GARDEN_CAP)
}

function ledgerFile(paths: VaultPaths): string {
  return join(paths.workspace, '.engram', LEDGER)
}

export async function sweepGarden(paths: VaultPaths, notes: Note[], now: Date = new Date()): Promise<GardenEvent[]> {
  const events: GardenEvent[] = []
  for (const candidate of gardenCandidates(notes, now)) {
    try {
      const note = await readNote(paths, candidate.front.id)
      // Re-check against the FILE, not the index: a recall stamped between
      // the index snapshot and now must win.
      if (note.front.status !== 'current') continue
      note.front.status = 'archived'
      note.front.updated = now.toISOString()
      await writeNote(paths, note)
      events.push({
        at: now.toISOString(),
        id: note.front.id,
        title: noteTitle(note),
        reason: note.front.last_recalled === undefined ? 'never-recalled' : 'recall-cold',
      })
    } catch {
      continue // a vanished or unreadable note is not the gardener's problem
    }
  }
  if (events.length > 0) {
    await mkdir(join(paths.workspace, '.engram'), { recursive: true }).catch(() => undefined)
    await appendFile(ledgerFile(paths), `${events.map((e) => JSON.stringify(e)).join('\n')}\n`).catch(() => undefined)
  }
  return events
}

// The brief's receipt: how many notes went to the shelf in the window.
export async function countGardenEvents(paths: VaultPaths, sinceMs: number): Promise<number> {
  try {
    const raw = await readFile(ledgerFile(paths), 'utf8')
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as GardenEvent
        } catch {
          return null
        }
      })
      .filter((event): event is GardenEvent => event !== null && Date.parse(event.at) >= sinceMs).length
  } catch {
    return 0
  }
}
