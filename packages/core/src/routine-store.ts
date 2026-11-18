import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { loadNotes, readNote, writeNote } from './notes.js'
import { frontmatterSchema, noteTitle, type Note } from './schema.js'
import type { VaultPaths } from './vault.js'
import { loadBots, readBotTranscript } from './bots.js'
import { routineTask } from './routine-task.js'
import {
  ROUTINE_NAME_CAP,
  normalizeStep,
  routineStepLabel,
  validateRoutineSteps,
  type Routine,
  type RoutineStep,
} from './routine-model.js'

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
    ...(meta.task ? { task: meta.task } : {}),
    createdAt: note.front.created,
    ...(meta.lastRunAt ? { lastRunAt: meta.lastRunAt } : {}),
    ...(meta.lastOutcome ? { lastOutcome: meta.lastOutcome } : {}),
    ...(meta.lastSuccessAt ? { lastSuccessAt: meta.lastSuccessAt } : {}),
    ...(meta.posts !== undefined ? { posts: meta.posts } : {}),
    ...(meta.pendingWrite ? { pendingWrite: meta.pendingWrite } : {}),
  }
}

function routineBody(name: string, steps: RoutineStep[], task?: Routine['task']): string {
  if (task) return `# ${name}\n\n${task.goal}\n`
  const listed = steps.map((step, i) => `${i + 1}. ${routineStepLabel(step)}`).join('\n')
  return `# ${name}\n\nA saved procedure — the app replays these steps exactly; edit the steps in the frontmatter above.\n\n${listed}\n`
}

function buildNote(id: string, name: string, steps: RoutineStep[], now: Date, run?: Routine, task?: Routine['task']): Note {
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
      ...(task ? { task } : {}),
      ...(run?.lastRunAt ? { lastRunAt: run.lastRunAt } : {}),
      ...(run?.lastOutcome ? { lastOutcome: run.lastOutcome } : {}),
      ...(run?.lastSuccessAt ? { lastSuccessAt: run.lastSuccessAt } : {}),
      ...(run?.posts !== undefined ? { posts: run.posts } : {}),
      ...(run?.pendingWrite ? { pendingWrite: run.pendingWrite } : {}),
    },
  })
  return { front, body: routineBody(name, steps, task) }
}

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
  }
  await rename(legacyPath, join(paths.cache, MIGRATED_FILE)).catch(() => undefined)
}

const listings = new Map<string, Promise<Routine[]>>()

export function listRoutines(paths: VaultPaths, now: Date = new Date()): Promise<Routine[]> {
  const pending = listings.get(paths.cache)
  if (pending) return pending
  const work = readRoutines(paths, now)
  listings.set(paths.cache, work)
  work.then(
    () => { if (listings.get(paths.cache) === work) listings.delete(paths.cache) },
    () => { if (listings.get(paths.cache) === work) listings.delete(paths.cache) },
  )
  return work
}

async function readRoutines(paths: VaultPaths, now: Date): Promise<Routine[]> {
  await migrateLegacy(paths, now)
  const notes = await loadNotes(paths)
  const existing = new Set(notes.map(note => note.front.id))
  for (const bot of await loadBots(paths)) {
    const tasks = (Array.isArray(bot.tasks) ? bot.tasks : []).filter(task => typeof task?.id === 'string' && /^[\w-]+$/.test(task.id) && /^[\w-]+$/.test(bot.id) && typeof task.name === 'string' && typeof task.goal === 'string' && task.goal.trim() && !task.routineId && !existing.has(`rt-task-${bot.id}-${task.id}`))
    if (!tasks.length) continue
    const context = (await readBotTranscript(paths, bot.id)).map(turn => turn.text)
    for (const task of tasks) {
      const id = `rt-task-${bot.id}-${task.id}`
      const created = new Date(bot.createdAt)
      const note = buildNote(id, task.name, [], Number.isFinite(created.getTime()) ? created : now, undefined, routineTask(task.goal, [], context))
      await writeNote(paths, note)
      notes.push(note)
    }
  }
  return notes
    .map(toRoutine)
    .filter((r): r is Routine => r !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function addRoutine(
  paths: VaultPaths,
  input: { name: string; steps: RoutineStep[]; task?: Routine['task']; id?: string },
  now: Date = new Date(),
): Promise<Routine> {
  const name = input.name.trim().slice(0, ROUTINE_NAME_CAP)
  if (!name) throw new Error('a routine needs a name')
  const invalid = input.task && input.steps.length === 0 ? null : validateRoutineSteps(input.steps)
  if (invalid) throw new Error(invalid)
  if (input.id && !/^rt-[a-z0-9-]{1,100}$/.test(input.id)) throw new Error('Invalid routine id')
  const id = input.id ?? `rt-${now.getTime().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`
  if (input.id) {
    try {
      const existing = toRoutine(await readNote(paths, id))
      if (!existing) throw new Error('This routine was archived or changed. Start a new draft instead.')
      return existing
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const steps = input.steps.map(normalizeStep)
  const note = buildNote(id, name, steps, now, undefined, input.task)
  await writeNote(paths, note)
  listings.delete(paths.cache)
  return toRoutine(note)!
}

export async function updateRoutineGoal(paths: VaultPaths, id: string, goal: string, now: Date = new Date()): Promise<void> {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 4000) throw new Error('Provide routine instructions of 1–4000 characters.')
  const note = await readNote(paths, id)
  const routine = toRoutine(note)
  if (!routine?.task || !note.front.routine?.task) throw new Error('This routine has no editable task instructions.')
  note.front.routine.task = { ...routine.task, goal: goal.trim() }
  delete note.front.routine.task.context
  note.body = routineBody(routine.name, routine.steps, note.front.routine.task)
  note.front.updated = now.toISOString()
  await writeNote(paths, note)
  listings.delete(paths.cache)
}

export async function renameRoutine(paths: VaultPaths, id: string, nextName: string, now: Date = new Date()): Promise<void> {
  const name = nextName.trim().slice(0, ROUTINE_NAME_CAP)
  if (!name) throw new Error('a routine needs a name')
  const note = await readNote(paths, id)
  const routine = toRoutine(note)
  if (!routine) throw new Error('no such routine')
  note.body = routineBody(name, routine.steps, routine.task)
  note.front.updated = now.toISOString()
  await writeNote(paths, note)
  listings.delete(paths.cache)
}

export async function removeRoutine(paths: VaultPaths, id: string, now: Date = new Date()): Promise<void> {
  try {
    const note = await readNote(paths, id)
    note.front.status = 'archived'
    note.front.updated = now.toISOString()
    await writeNote(paths, note)
    listings.delete(paths.cache)
  } catch {
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
  await writeNote(paths, note)
  listings.delete(paths.cache)
}

export async function markRoutineRun(
  paths: VaultPaths,
  id: string,
  outcome: 'done' | 'failed' | 'aborted',
  now: Date = new Date(),
  posted = false,
): Promise<void> {
  await patchRun(paths, id, (meta) => {
    meta.lastRunAt = now.toISOString()
    meta.lastOutcome = outcome
    if (posted) meta.posts = true
    if (outcome === 'done') {
      meta.posts ??= false
      meta.lastSuccessAt = meta.lastRunAt
      delete meta.pendingWrite
    }
  })
}

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
