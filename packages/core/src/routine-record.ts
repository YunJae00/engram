import { ROUTINE_KEYS, type RoutineStep } from './routine-model.js'

const REPLAYABLE_KEYS = new Set<string>(ROUTINE_KEYS)

// A turn that got a web job done leaves a trail of steps - dead ends,
// retries, looks - and somewhere in it the path that worked. This distils
// that path into a procedure: only the moves that changed the page and were
// not refused, by the words on the controls, in the order they happened.
// The wandering is left behind; what is kept is what a person would write
// down after doing the job once.

export interface TurnStep {
  tool: string
  args: Record<string, unknown>
  observation: string
  observedAfterAction?: boolean
  // The move did something that cannot be taken back, such as a press the person approved.
  committed?: boolean
  seeded?: boolean
}

// A move whose own report says it went nowhere is not part of the path.
const WENT_NOWHERE = [
  'that did not work:',
  'could not',
  'nothing on the page changed',
  'was not pressed',
  'needs a person',
  'did not answer that in time',
  'is not in any of its',
  'was not found in the current readable extract',
]

function worked(observation: string): boolean {
  try { const value = JSON.parse(observation); if (value?.error || value?.reobserveRequired || value?.observationMayBeStale || value?.completeReadback === false) return false } catch { /* Browser receipts also use plain text. */ }
  const head = observation.slice(0, 200).toLowerCase()
  return !WENT_NOWHERE.some((sign) => head.includes(sign))
}

export function successfulTurnSteps(steps: TurnStep[]): TurnStep[] {
  return steps.filter(step => !step.seeded && worked(step.observation))
}

function words(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

// The successful path, as replayable steps. A control named only by its
// number (#12) is left out - numbers are the order of one reading and mean
// nothing on the next visit. Keys cannot depend on an omitted interaction.
// A batch of page moves counts move by move, up to the one it stopped at.
export function recordedSteps(steps: TurnStep[]): RoutineStep[] {
  const out: RoutineStep[] = []
  let keyContextRecorded = true
  const pushRead = (): void => { if (out.length === 0 || out[out.length - 1]!.kind !== 'read') out.push({ kind: 'read' }) }
  // One move on the page; false when the path can no longer be replayed faithfully.
  const move = (tool: string, args: Record<string, unknown>): boolean => {
    if (tool === 'press') {
      const target = words(args, 'target')
      if (target && !target.startsWith('#')) out.push({ kind: 'click', target: { text: target } })
      else keyContextRecorded = false
      return true
    }
    if (tool === 'type_text') {
      const target = words(args, 'target')
      const text = words(args, 'text')
      if (target && text && !target.startsWith('#')) {
        out.push({ kind: 'type', target: { text: target }, text })
        // Preserve the key that requested the search results.
        if (args['enter'] === true) {
          if (!keyContextRecorded) return false
          out.push({ kind: 'key', key: 'Enter' })
        }
        return true
      }
      if (args['enter'] === true) return false
      keyContextRecorded = false
      return true
    }
    if (tool === 'press_key') {
      const key = words(args, 'key')
      if (!keyContextRecorded) return false
      if (REPLAYABLE_KEYS.has(key)) out.push({ kind: 'key', key })
      else keyContextRecorded = false
      return true
    }
    keyContextRecorded = false
    return true
  }
  for (const step of steps) {
    if (step.seeded) continue
    if (step.tool === 'page_steps') {
      const moves = Array.isArray(step.args['steps']) ? (step.args['steps'] as unknown[]).filter((one): one is Record<string, unknown> => !!one && typeof one === 'object' && !Array.isArray(one)) : []
      const stopped = /Stopped at move (\d+) of/.exec(step.observation.slice(0, 200))
      const made = worked(step.observation) ? moves.length : stopped ? Number(stopped[1]) - 1 : 0
      for (const one of moves.slice(0, made)) {
        const kind = words(one, 'do')
        if (!['press', 'type', 'key'].includes(kind)) return []
        const tool = kind === 'press' ? 'press' : kind === 'type' ? 'type_text' : kind === 'key' ? 'press_key' : kind
        if (!move(tool, kind === 'key' ? { key: one['key'] } : one)) return []
      }
      continue
    }
    if (!worked(step.observation)) continue
    // Batch checks cannot be represented by the legacy click-only replay format.
    if (step.tool === 'read_pages' || step.tool === 'page_do') return []
    if (step.tool === 'open_page') {
      const url = words(step.args, 'url')
      if (/^https?:\/\//i.test(url)) {
        // A later open supersedes wandering before it only when nothing was
        // pressed in between; a re-open after clicks is part of the path.
        if (out.length > 0 && out[out.length - 1]!.kind === 'open') out.pop()
        out.push({ kind: 'open', url })
        keyContextRecorded = true
      }
      continue
    }
    if (['press', 'type_text', 'press_key'].includes(step.tool)) { if (!move(step.tool, step.args)) return []; continue }
    // Keep explicit observations and collapse only adjacent reads.
    if (step.tool === 'read_open_page' || step.tool === 'look') { pushRead(); continue }
    if (['choose', 'press_point', 'hover', 'reveal'].includes(step.tool)) keyContextRecorded = false
  }
  // A recording that never opens a page replays nothing worth keeping.
  if (!out.some((step) => step.kind === 'open')) return []
  // Include the final state even when the turn did not explicitly read it.
  pushRead()
  return out
}
