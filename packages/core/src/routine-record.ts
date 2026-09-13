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
export function recordedSteps(steps: TurnStep[]): RoutineStep[] {
  const out: RoutineStep[] = []
  let keyContextRecorded = true
  const pushRead = (): void => { if (out.length === 0 || out[out.length - 1]!.kind !== 'read') out.push({ kind: 'read' }) }
  for (const step of successfulTurnSteps(steps)) {
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
    if (step.tool === 'press') {
      const target = words(step.args, 'target')
      if (target && !target.startsWith('#')) out.push({ kind: 'click', target: { text: target } })
      else keyContextRecorded = false
      continue
    }
    if (step.tool === 'type_text') {
      const target = words(step.args, 'target')
      const text = words(step.args, 'text')
      if (target && text && !target.startsWith('#')) {
        out.push({ kind: 'type', target: { text: target }, text })
        // Preserve the key that requested the search results.
        if (step.args['enter'] === true) {
          if (!keyContextRecorded) return []
          out.push({ kind: 'key', key: 'Enter' })
        }
      } else {
        if (step.args['enter'] === true) return []
        keyContextRecorded = false
      }
      continue
    }
    if (step.tool === 'press_key') {
      const key = words(step.args, 'key')
      if (!keyContextRecorded) return []
      if (REPLAYABLE_KEYS.has(key)) out.push({ kind: 'key', key })
      else keyContextRecorded = false
      continue
    }
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
