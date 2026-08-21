import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { loadNotes, readNote, writeNote } from './notes.js'
import { frontmatterSchema, noteTitle, type Note } from './schema.js'
import type { VaultPaths } from './vault.js'
import {
  ROUTINE_NAME_CAP,
  normalizeStep,
  routineStepLabel,
  validateRoutineSteps,
  type Routine,
  type RoutineStep,
} from './routine-model.js'

// A procedure is knowledge: "this is how we file the weekly report" belongs
// in the vault beside "this is what we decided" — searchable, synced by git,
// editable by hand. So a routine is a NOTE of type 'routine': the replayable
// steps ride in frontmatter, the body stays a human description. The old
// cache file (.engram/routines.json) migrates in on first read.

const LEGACY_FILE = 'routines.json'
const MIGRATED_FILE = 'routines-migrated.json'

function toRoutine(note: Note): Routine | null {
  const meta = note.front.routine
  if (note.front.type !== 'routine' || !meta || note.front.status !== 'current') return null
  if (!Array.isArray(meta.steps)) return null
  return {
    id: note.front.id,
    name: noteTitle(note).slice(0, ROUTINE_NAME_CAP),
    steps: meta.steps as RoutineStep[],
    createdAt: note.front.created,
    ...(meta.lastRunAt ? { lastRunAt: meta.lastRunAt } : {}),
    ...(meta.lastOutcome ? { lastOutcome: meta.lastOutcome } : {}),
    ...(meta.lastSuccessAt ? { lastSuccessAt: meta.lastSuccessAt } : {}),
    ...(meta.pendingWrite ? { pendingWrite: meta.pendingWrite } : {}),
  }
}

function routineBody(name: string, steps: RoutineStep[]): string {
  const listed = steps.map((step, i) => `${i + 1}. ${routineStepLabel(step)}`).join('\n')
  return `# ${name}\n\nA saved procedure — the app replays these steps exactly; edit the steps in the frontmatter above.\n\n${listed}\n`
}

function buildNote(id: string, name: string, steps: RoutineStep[], now: Date, run?: Routine): Note {
  // Evergreen and off the timeline: a procedure does not go stale by itself
  // and is not an event. parse() fills the remaining defaults.
  const front = frontmatterSchema.parse({
    id,
    type: 'routine',
    status: 'current',
    decay: 'evergreen',
    timeline: 'ignore',
    created: run?.createdAt ?? now.toISOString(),
    updated: now.toISOString(),
    routine: {
      steps,
      ...(run?.lastRunAt ? { lastRunAt: run.lastRunAt } : {}),
      ...(run?.lastOutcome ? { lastOutcome: run.lastOutcome } : {}),
      ...(run?.lastSuccessAt ? { lastSuccessAt: run.lastSuccessAt } : {}),
      ...(run?.pendingWrite ? { pendingWrite: run.pendingWrite } : {}),
    },
  })
  return { front, body: routineBody(name, steps) }
}

// The old cache file becomes notes on first contact, then steps aside under
// another name so this runs once. Nothing a person saved is thrown away.
async function migrateLegacy(paths: VaultPaths, now: Date): Promise<void> {
  const legacyPath = join(paths.cache, LEGACY_FILE)
  let raw: string
  try {
    raw = await readFile(legacyPath, 'utf8')
  } catch {
    return
  }
  try {
    const parsed = JSON.parse(raw) as { routines?: Routine[] }
    for (const legacy of parsed.routines ?? []) {
      if (typeof legacy?.id !== 'string' || typeof legacy?.name !== 'string' || !Array.isArray(legacy?.steps)) continue
      const exists = await readNote(paths, legacy.id).then(() => true).catch(() => false)
      if (exists) continue
      await writeNote(paths, buildNote(legacy.id, legacy.name, legacy.steps, now, legacy))
    }
  } catch {
    // an unreadable legacy file must not block the notes that already exist
  }
  await rename(legacyPath, join(paths.cache, MIGRATED_FILE)).catch(() => undefined)
}

export async function listRoutines(paths: VaultPaths, now: Date = new Date()): Promise<Routine[]> {
  await migrateLegacy(paths, now)
  const notes = await loadNotes(paths)
  return notes
    .map(toRoutine)
    .filter((r): r is Routine => r !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function addRoutine(
  paths: VaultPaths,
  input: { name: string; steps: RoutineStep[] },
  now: Date = new Date(),
): Promise<Routine> {
  const name = input.name.trim().slice(0, ROUTINE_NAME_CAP)
  if (!name) throw new Error('a routine needs a name')
  const invalid = validateRoutineSteps(input.steps)
  if (invalid) throw new Error(invalid)
  const id = `rt-${now.getTime().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
  const steps = input.steps.map(normalizeStep)
  const note = buildNote(id, name, steps, now)
  await writeNote(paths, note)
  return toRoutine(note)!
}

// Archive, not delete: the note keeps its history and leaves the list.
export async function removeRoutine(paths: VaultPaths, id: string, now: Date = new Date()): Promise<void> {
  try {
    const note = await readNote(paths, id)
    note.front.status = 'archived'
    note.front.updated = now.toISOString()
    await writeNote(paths, note)
  } catch {
    /* already gone */
  }
}

async function patchRun(paths: VaultPaths, id: string, patch: (meta: NonNullable<Note['front']['routine']>) => void): Promise<void> {
  let note: Note
  try {
    note = await readNote(paths, id)
  } catch {
    return
  }
  if (!note.front.routine) return
  patch(note.front.routine)
  // Deliberately does NOT touch `updated`: a run is not an edit, and stamping
  // it would drag the note through the librarian's delta on every replay.
  await writeNote(paths, note)
}

export async function markRoutineRun(
  paths: VaultPaths,
  id: string,
  outcome: 'done' | 'failed' | 'aborted',
  now: Date = new Date(),
): Promise<void> {
  await patchRun(paths, id, (meta) => {
    meta.lastRunAt = now.toISOString()
    meta.lastOutcome = outcome
    // A clean finish is what clears the in-flight submit marker. A failure or
    // an abort deliberately leaves it standing: that is the whole signal.
    if (outcome === 'done') {
      meta.lastSuccessAt = meta.lastRunAt
      delete meta.pendingWrite
    }
  })
}

// A run that stopped BEFORE the click — the person said "not yet" — leaves no
// doubt about whether anything was posted, so it must leave no warning either.
export async function clearRoutinePendingWrite(paths: VaultPaths, id: string): Promise<void> {
  await patchRun(paths, id, (meta) => {
    delete meta.pendingWrite
  })
}

export async function markRoutinePendingWrite(
  paths: VaultPaths,
  id: string,
  mark: NonNullable<Routine['pendingWrite']>,
): Promise<void> {
  await patchRun(paths, id, (meta) => {
    meta.pendingWrite = mark
  })
}
