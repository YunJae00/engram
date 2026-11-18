export interface RoutineTarget {
  css?: string[]
  text?: string
}

export type RoutineStep =
  | { kind: 'open'; url: string }
  | { kind: 'click'; target: RoutineTarget }
  | { kind: 'type'; target: RoutineTarget; text: string; example?: string }
  | { kind: 'key'; key: string }
  | { kind: 'read' }

export const ROUTINE_KEYS = ['Enter', 'Escape', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'] as const

export interface Routine {
  id: string
  name: string
  steps: RoutineStep[]
  task?: { goal: string; urls: string[]; method: string[]; surface: 'web' | 'auto'; context?: string[]; checks?: string[]; execution?: { engine: 'claude' | 'codex'; model: string; effort?: import('./engine/types.js').ReasoningEffort } }
  createdAt: string
  lastRunAt?: string
  lastOutcome?: 'done' | 'failed' | 'aborted'
  lastSuccessAt?: string
  posts?: boolean
  pendingWrite?: { at: string; step: number; label: string }
}

export interface RoutineReading {
  url: string
  title: string
  text: string
}

export interface RoutineStepResult {
  ok: boolean
  recoverable?: boolean
  wall?: 'login' | 'captcha'
  error?: string
}

export interface RoutineDriver {
  open(url: string, signal?: AbortSignal): Promise<RoutineStepResult>
  click(target: RoutineTarget, signal?: AbortSignal): Promise<RoutineStepResult>
  type(target: RoutineTarget, text: string, signal?: AbortSignal): Promise<RoutineStepResult>
  key(key: string, signal?: AbortSignal): Promise<RoutineStepResult>
  read(signal?: AbortSignal): Promise<RoutineReading & { wall?: 'login' | 'captcha' }>
  location?(): string | null
}

export interface RoutineRunOptions {
  signal?: AbortSignal
  onStep?(index: number, total: number, label: string): void
  onWall?(wall: { url?: string; wall: 'login' | 'captcha' }): Promise<'resolved' | 'skip'>
  now?: () => Date
  force?: boolean
  onSubmit?(preview: {
    routine: string
    routineId: string
    url: string | null
    filled: { label: string; text: string }[]
  }): Promise<'approve' | 'always' | 'cancel'>
}

export type RoutineBlock = 'already-ran-today' | 'unfinished-write'

export interface RoutineRunResult {
  ok: boolean
  resumeFrom?: number
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
    } else if (step.kind === 'key') {
      if (!(ROUTINE_KEYS as readonly string[]).includes(step.key)) return `"${String(step.key).slice(0, 40)}" is not a key a routine may press`
    } else if (step.kind !== 'read') {
      return 'unknown step kind'
    }
  }
  return null
}

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
      return { kind: 'type', target: normalizeTarget(step.target), text: step.text, ...(step.example ? { example: step.example } : {}) }
    case 'key':
      return { kind: 'key', key: step.key }
    case 'read':
      return { kind: 'read' }
  }
}

export function routineWrites(routine: Routine): boolean {
  return !!routine.task || routine.steps.some((step) => step.kind === 'type')
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
  if ((routine.posts ?? routineWrites(routine)) && sameLocalDay(routine.lastSuccessAt, now)) return 'already-ran-today'
  return null
}

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

const SLOT = /\{\{\s*([\p{L}\p{N}_-]{1,40})\s*\}\}/gu

export function routineSlots(steps: RoutineStep[]): string[] {
  const names = new Set<string>()
  for (const step of steps) {
    if (step.kind !== 'type') continue
    for (const match of step.text.matchAll(SLOT)) names.add(match[1]!)
  }
  return [...names]
}

export function routineSlotExamples(steps: RoutineStep[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const step of steps) {
    if (step.kind !== 'type' || !step.example) continue
    const only = /^\{\{\s*([\p{L}\p{N}_-]{1,40})\s*\}\}$/u.exec(step.text)
    if (only) out[only[1]!] = step.example
  }
  return out
}

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
    case 'key':
      return `Press ${step.key}`
    case 'read':
      return 'Read the page'
  }
}
