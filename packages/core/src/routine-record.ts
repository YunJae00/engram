import type { RoutineStep } from './routine-model.js'

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
  'could not',
  'nothing on the page changed',
  'was not pressed',
  'needs a person',
  'did not answer that in time',
  'is not in any of its',
]

function worked(observation: string): boolean {
  const head = observation.slice(0, 200).toLowerCase()
  return !WENT_NOWHERE.some((sign) => head.includes(sign))
}

function words(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value.trim() : ''
}

// The successful path, as replayable steps. A control named only by its
// number (#12) is left out - numbers are the order of one reading and mean
// nothing on the next visit; a step like that makes the recording shorter,
// not wrong, because the replay reads the page and the model fills gaps.
export function recordedSteps(steps: TurnStep[]): RoutineStep[] {
  const out: RoutineStep[] = []
  for (const step of steps) {
    if (step.seeded || !worked(step.observation)) continue
    if (step.tool === 'open_page') {
      const url = words(step.args, 'url')
      if (/^https?:\/\//i.test(url)) {
        // A later open supersedes wandering before it only when nothing was
        // pressed in between; a re-open after clicks is part of the path.
        if (out.length > 0 && out[out.length - 1]!.kind === 'open') out.pop()
        out.push({ kind: 'open', url })
      }
      continue
    }
    if (step.tool === 'press') {
      const target = words(step.args, 'target')
      if (target && !target.startsWith('#')) out.push({ kind: 'click', target: { text: target } })
      continue
    }
    if (step.tool === 'type_text') {
      const target = words(step.args, 'target')
      const text = words(step.args, 'text')
      if (target && text && !target.startsWith('#')) out.push({ kind: 'type', target: { text: target }, text })
      continue
    }
    // Everything else - looks, reads, scrolls, hovers, memory searches - is
    // how the path was found, not the path itself.
  }
  // A recording that never opens a page replays nothing worth keeping.
  return out.some((step) => step.kind === 'open') ? out : []
}
