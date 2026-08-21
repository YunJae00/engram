import type { RoutineStepDto } from '../../../shared/types.js'

// One short human line per step — the renderer twin of core's routineStepLabel
// (core cannot be imported across the IPC boundary).
export function stepLine(step: RoutineStepDto): string {
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
