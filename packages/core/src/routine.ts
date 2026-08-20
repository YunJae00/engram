import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { VaultPaths } from './vault.js'
import { createCard } from './cards.js'

// A routine is repetition with the thinking already done: the exact pages,
// clicks and readings a person walks every day, saved once and replayed
// verbatim. No model is involved — the replay is deterministic code — which
// is what makes it dependable on a machine too tight for inference, and what
// keeps a 99-in-100 success rate reachable at all.

export interface RoutineTarget {
  // Ordered fallbacks: CSS selectors are precise but brittle, the visible
  // text survives redesigns. The driver tries them in this order.
  css?: string[]
  text?: string
}

export type RoutineStep =
  | { kind: 'open'; url: string }
  | { kind: 'click'; target: RoutineTarget }
  | { kind: 'type'; target: RoutineTarget; text: string }
  | { kind: 'read' }

export interface Routine {
  id: string
  name: string
  steps: RoutineStep[]
  createdAt: string
  lastRunAt?: string
  lastOutcome?: 'done' | 'failed' | 'aborted'
  lastSuccessAt?: string
  // Written immediately BEFORE a step that can post something, cleared only
  // when the run finishes cleanly. Finding one on disk means a submit may
  // already have gone through - the person decides, not the code.
  pendingWrite?: { at: string; step: number; label: string }
}

export interface RoutineReading {
  url: string
  title: string
  text: string
}

export interface RoutineStepResult {
  ok: boolean
  wall?: 'login' | 'captcha'
  error?: string
}

// The seam between the pure engine and the browser: the desktop implements
// this over its agent Chrome, tests hand in a fake. Every operation settles
// the page and reports a wall when one appeared under it.
export interface RoutineDriver {
  open(url: string, signal?: AbortSignal): Promise<RoutineStepResult>
  click(target: RoutineTarget, signal?: AbortSignal): Promise<RoutineStepResult>
  type(target: RoutineTarget, text: string, signal?: AbortSignal): Promise<RoutineStepResult>
  read(signal?: AbortSignal): Promise<RoutineReading & { wall?: 'login' | 'captcha' }>
}

export interface RoutineRunOptions {
  signal?: AbortSignal
  onStep?(index: number, total: number, label: string): void
  // 'resolved' means the human handled the wall in the agent window — the
  // step retries once. Anything else stops the run: a routine is a sequence,
  // and a skipped link breaks every step after it.
  onWall?(wall: { url?: string; wall: 'login' | 'captcha' }): Promise<'resolved' | 'skip'>
  now?: () => Date
  // The person answered the rerun question with "yes, again".
  force?: boolean
}

// Why a rerun was refused. Not an error: the answer may well be "run it
// anyway", and only a person can give it.
export type RoutineBlock = 'already-ran-today' | 'unfinished-write'

export interface RoutineRunResult {
  ok: boolean
  blocked?: RoutineBlock
  readings: RoutineReading[]
  cardId?: string
  error?: string
}

const ROUTINES_FILE = 'routines.json'
const NAME_CAP = 60
const MAX_STEPS = 30
const TARGET_TEXT_CAP = 120
const TYPE_TEXT_CAP = 500
const URL_CAP = 2_000
const CSS_CAP = 8
const CSS_LEN_CAP = 300
// One card body: generous enough for a few portal pages, small enough that
// review stays readable.
const CARD_BODY_CAP = 24_000

function routinesPath(paths: VaultPaths): string {
  return join(paths.cache, ROUTINES_FILE)
}

export async function listRoutines(paths: VaultPaths): Promise<Routine[]> {
  try {
    const raw = JSON.parse(await readFile(routinesPath(paths), 'utf8')) as { routines?: Routine[] }
    return Array.isArray(raw.routines)
      ? raw.routines.filter((r) => typeof r?.id === 'string' && typeof r?.name === 'string' && Array.isArray(r?.steps))
      : []
  } catch {
    return []
  }
}

async function saveRoutines(paths: VaultPaths, routines: Routine[]): Promise<void> {
  await mkdir(paths.cache, { recursive: true })
  await writeFile(routinesPath(paths), JSON.stringify({ routines }, null, 2))
}

// Human-readable rejection or null. Pure so validation has a unit test and
// the renderer can trust that whatever saved will also run.
export function validateRoutineSteps(steps: RoutineStep[]): string | null {
  if (!Array.isArray(steps) || steps.length === 0) return 'a routine needs at least one step'
  if (steps.length > MAX_STEPS) return `a routine is capped at ${MAX_STEPS} steps`
  for (const step of steps) {
    if (step.kind === 'open') {
      let parsed: URL
      try {
        parsed = new URL(step.url)
      } catch {
        return `"${String(step.url).slice(0, 80)}" is not a full web address`
      }
      // http(s) only: a replayed file:// or chrome:// URL is an open door.
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        return 'a routine can only open http(s) pages'
      if (step.url.length > URL_CAP) return 'that web address is too long to save'
    } else if (step.kind === 'click' || step.kind === 'type') {
      const target = step.target ?? {}
      const text = target.text?.trim() ?? ''
      const css = target.css ?? []
      if (!text && css.length === 0) return 'a click or type step needs the element text or a selector'
      if (text.length > TARGET_TEXT_CAP) return 'element text is capped at 120 characters'
      if (css.length > CSS_CAP || css.some((s) => typeof s !== 'string' || s.length > CSS_LEN_CAP))
        return 'too many or too long selectors on one step'
      if (step.kind === 'type' && (typeof step.text !== 'string' || step.text.length > TYPE_TEXT_CAP))
        return 'typed text is capped at 500 characters'
    } else if (step.kind !== 'read') {
      return 'unknown step kind'
    }
  }
  return null
}

// Steps are rebuilt field by field before they are stored: whatever else
// arrived on the object stays out of routines.json, which is read back and
// handed over IPC on every listing.
function normalizeTarget(target: RoutineTarget): RoutineTarget {
  const out: RoutineTarget = {}
  const css = (target.css ?? []).map((one) => one.trim()).filter(Boolean)
  if (css.length > 0) out.css = css
  const text = target.text?.trim()
  if (text) out.text = text
  return out
}

function normalizeStep(step: RoutineStep): RoutineStep {
  switch (step.kind) {
    case 'open':
      return { kind: 'open', url: step.url.trim() }
    case 'click':
      return { kind: 'click', target: normalizeTarget(step.target) }
    case 'type':
      return { kind: 'type', target: normalizeTarget(step.target), text: step.text }
    case 'read':
      return { kind: 'read' }
  }
}

// A routine that types into a page can post something, and posting twice is
// not always something a person can undo. Those ask before a same-day rerun;
// a read-only routine is harmless to repeat and never asks.
export function routineWrites(routine: Routine): boolean {
  return routine.steps.some((step) => step.kind === 'type')
}

function sameLocalDay(iso: string | undefined, now: Date): boolean {
  if (!iso) return false
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return false
  return (
    then.getFullYear() === now.getFullYear() && then.getMonth() === now.getMonth() && then.getDate() === now.getDate()
  )
}

export function routineBlock(routine: Routine, now: Date = new Date()): RoutineBlock | null {
  if (routine.pendingWrite) return 'unfinished-write'
  if (routineWrites(routine) && sameLocalDay(routine.lastSuccessAt, now)) return 'already-ran-today'
  return null
}

// Once something has been typed, every later click could be the one that
// submits - mark them all rather than guess which.
function writeStepIndexes(steps: RoutineStep[]): Set<number> {
  const marked = new Set<number>()
  let typed = false
  steps.forEach((step, i) => {
    if (step.kind === 'type') {
      marked.add(i)
      typed = true
    } else if (step.kind === 'click' && typed) marked.add(i)
  })
  return marked
}

export async function addRoutine(
  paths: VaultPaths,
  input: { name: string; steps: RoutineStep[] },
  now: Date = new Date(),
): Promise<Routine> {
  const name = input.name.trim().slice(0, NAME_CAP)
  if (!name) throw new Error('a routine needs a name')
  const invalid = validateRoutineSteps(input.steps)
  if (invalid) throw new Error(invalid)
  const routines = await listRoutines(paths)
  const routine: Routine = {
    id: `rt-${now.getTime().toString(36)}-${Math.floor(Math.random() * 0xffff).toString(16)}`,
    name,
    steps: input.steps.map(normalizeStep),
    createdAt: now.toISOString(),
  }
  await saveRoutines(paths, [...routines, routine])
  return routine
}

export async function removeRoutine(paths: VaultPaths, id: string): Promise<void> {
  const routines = await listRoutines(paths)
  await saveRoutines(paths, routines.filter((r) => r.id !== id))
}

export async function markRoutineRun(
  paths: VaultPaths,
  id: string,
  outcome: 'done' | 'failed' | 'aborted',
  now: Date = new Date(),
): Promise<void> {
  const routines = await listRoutines(paths)
  const routine = routines.find((r) => r.id === id)
  if (!routine) return
  routine.lastRunAt = now.toISOString()
  routine.lastOutcome = outcome
  // A clean finish is what clears the in-flight submit marker. A failure or
  // an abort deliberately leaves it standing: that is the whole signal.
  if (outcome === 'done') {
    routine.lastSuccessAt = routine.lastRunAt
    delete routine.pendingWrite
  }
  await saveRoutines(paths, routines)
}

async function notePendingWrite(paths: VaultPaths, id: string, mark: Routine['pendingWrite']): Promise<void> {
  const routines = await listRoutines(paths)
  const routine = routines.find((r) => r.id === id)
  if (!routine) return
  routine.pendingWrite = mark
  await saveRoutines(paths, routines)
}

// The one-line description a progress row shows for a step.
export function routineStepLabel(step: RoutineStep): string {
  switch (step.kind) {
    case 'open': {
      try {
        return `Open ${new URL(step.url).hostname}`
      } catch {
        return 'Open a page'
      }
    }
    case 'click':
      return step.target.text ? `Click "${step.target.text}"` : 'Click an element'
    case 'type':
      return step.target.text ? `Type into "${step.target.text}"` : 'Type into a field'
    case 'read':
      return 'Read the page'
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('canceled')
}

async function runStep(
  driver: RoutineDriver,
  step: RoutineStep,
  readings: RoutineReading[],
  signal?: AbortSignal,
): Promise<RoutineStepResult> {
  switch (step.kind) {
    case 'open':
      return driver.open(step.url, signal)
    case 'click':
      return driver.click(step.target, signal)
    case 'type':
      return driver.type(step.target, step.text, signal)
    case 'read': {
      const reading = await driver.read(signal)
      if (reading.wall) return { ok: false, wall: reading.wall }
      readings.push({ url: reading.url, title: reading.title, text: reading.text })
      return { ok: true }
    }
  }
}

// Every line of a page arrives quoted. A page is untrusted text: spliced in
// raw it could write its own "## Heading" and "Source:" lines and forge a
// reading the routine never took. Inside a blockquote it can only look like
// what it is — words the routine brought back from somewhere.
function quote(text: string): string {
  return text
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
}

function readingsBody(name: string, readings: RoutineReading[], now: Date): string {
  const date = now.toISOString().slice(0, 10)
  const sections = readings.map((r) => `## ${r.title || r.url}\n\nSource: ${r.url}\n\n${quote(r.text)}`)
  return `# ${name} — ${date}\n\n${sections.join('\n\n')}`.slice(0, CARD_BODY_CAP)
}

// Replays a routine step by step. A wall pauses the run on the host's
// onWall answer and retries the same step once — the human logged in, the
// page should pass now. Readings land as one review card, never a direct
// vault write: the routine collects, the person decides what is kept.
export async function runRoutine(
  paths: VaultPaths,
  driver: RoutineDriver,
  routine: Routine,
  options: RoutineRunOptions = {},
): Promise<RoutineRunResult> {
  const now = options.now ?? (() => new Date())
  const invalid = validateRoutineSteps(routine.steps)
  const readings: RoutineReading[] = []
  const finish = async (result: RoutineRunResult): Promise<RoutineRunResult> => {
    const outcome = result.ok ? 'done' : result.error === 'canceled' ? 'aborted' : 'failed'
    await markRoutineRun(paths, routine.id, outcome, now()).catch(() => undefined)
    return result
  }
  if (invalid) return finish({ ok: false, readings, error: invalid })
  // Refused before anything moves, and without stamping the journal: a run
  // that never started is not a run.
  const blocked = options.force ? null : routineBlock(routine, now())
  if (blocked) return { ok: false, readings, blocked }
  const writeSteps = writeStepIndexes(routine.steps)
  try {
    const total = routine.steps.length
    for (let i = 0; i < total; i++) {
      const step = routine.steps[i]!
      checkAbort(options.signal)
      const label = routineStepLabel(step)
      options.onStep?.(i, total, label)
      // The intent to post is on disk before the click that posts. If the
      // machine dies right here, the next run knows to ask.
      if (writeSteps.has(i)) await notePendingWrite(paths, routine.id, { at: now().toISOString(), step: i, label })
      let result = await runStep(driver, step, readings, options.signal)
      if (result.wall) {
        const verdict = (await options.onWall?.({ wall: result.wall })) ?? 'skip'
        checkAbort(options.signal)
        if (verdict !== 'resolved')
          return finish({ ok: false, readings, error: 'stopped at a page that needs a person' })
        result = await runStep(driver, step, readings, options.signal)
        if (result.wall)
          return finish({ ok: false, readings, error: 'the page still wants a login — the routine stopped there' })
      }
      if (!result.ok) return finish({ ok: false, readings, error: result.error ?? 'a step failed' })
    }
    if (readings.length === 0) return finish({ ok: true, readings })
    const card = await createCard(
      paths,
      {
        cardType: 'new-note',
        targets: [],
        rationale: `routine: ${routine.name}`.slice(0, 160),
        proposed: readingsBody(routine.name, readings, now()),
        job: 'J1',
      },
      now(),
    )
    return finish({ ok: true, readings, cardId: card.id })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return finish({ ok: false, readings, error: message })
  }
}
