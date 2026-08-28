// The routine vocabulary: what a saved procedure is made of, what makes one
// valid, and the small pure judgments (does it write? may it rerun?) that the
// store and the runner both need. No IO lives here.

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
  // The address the driver is on right now, when it can say. What an
  // approval is remembered against.
  location?(): string | null
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
  // Asked once, before the click that could post: the person sees exactly
  // what was typed into the page and says whether it may go. Anything but
  // 'approve' stops the run with nothing submitted. No handler means no
  // approval was possible, so the run stops rather than posting unasked.
  // 'always' is an approval the person asked the host to remember for this
  // procedure on this site; to the run it is an approve.
  onSubmit?(preview: {
    routine: string
    routineId: string
    url: string | null
    filled: { label: string; text: string }[]
  }): Promise<'approve' | 'always' | 'cancel'>
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

export const ROUTINE_NAME_CAP = 60
const MAX_STEPS = 30
const TARGET_TEXT_CAP = 120
const TYPE_TEXT_CAP = 500
const URL_CAP = 2_000
const CSS_CAP = 8
const CSS_LEN_CAP = 300

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
// arrived on the object stays out of the note, which is read back and handed
// over IPC on every listing.
function normalizeTarget(target: RoutineTarget): RoutineTarget {
  const out: RoutineTarget = {}
  const css = (target.css ?? []).map((one) => one.trim()).filter(Boolean)
  if (css.length > 0) out.css = css
  const text = target.text?.trim()
  if (text) out.text = text
  return out
}

export function normalizeStep(step: RoutineStep): RoutineStep {
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
export function writeStepIndexes(steps: RoutineStep[]): Set<number> {
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

// The blanks a procedure leaves for the day it runs: "{{today}}" in a typed
// value is a slot, filled fresh each time rather than replayed verbatim.
const SLOT = /\{\{\s*([\w-]{1,40})\s*\}\}/g

export function routineSlots(steps: RoutineStep[]): string[] {
  const names = new Set<string>()
  for (const step of steps) {
    if (step.kind !== 'type') continue
    for (const match of step.text.matchAll(SLOT)) names.add(match[1]!)
  }
  return [...names]
}

// Unfilled slots stay as they are rather than becoming an empty string: a
// half-filled form the person can see beats a silently blanked one.
export function fillSlots(steps: RoutineStep[], slots: Record<string, string>): RoutineStep[] {
  return steps.map((step) =>
    step.kind === 'type'
      ? {
          ...step,
          text: step.text.replace(SLOT, (whole, name: string) =>
            typeof slots[name] === 'string' ? slots[name]! : whole,
          ),
        }
      : step,
  )
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
