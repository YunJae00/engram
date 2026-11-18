import { ROUTINE_KEYS, type RoutineStep } from './routine-model.js'

const REPLAYABLE_KEYS = new Set<string>(ROUTINE_KEYS)

export interface TurnStep {
  tool: string
  args: Record<string, unknown>
  observation: string
  observedAfterAction?: boolean
  committed?: boolean
  seeded?: boolean
}

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
  try { const value = JSON.parse(observation); if (value?.error || value?.reobserveRequired || value?.observationMayBeStale || value?.completeReadback === false) return false } catch { }
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

export function recordedSteps(steps: TurnStep[]): RoutineStep[] {
  const out: RoutineStep[] = []
  let keyContextRecorded = true
  const pushRead = (): void => { if (out.length === 0 || out[out.length - 1]!.kind !== 'read') out.push({ kind: 'read' }) }
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
    if (step.tool === 'read_pages' || step.tool === 'page_do') return []
    if (step.tool === 'open_page') {
      const url = words(step.args, 'url')
      if (/^https?:\/\//i.test(url)) {
        if (out.length > 0 && out[out.length - 1]!.kind === 'open') out.pop()
        out.push({ kind: 'open', url })
        keyContextRecorded = true
      }
      continue
    }
    if (['press', 'type_text', 'press_key'].includes(step.tool)) { if (!move(step.tool, step.args)) return []; continue }
    if (step.tool === 'read_open_page' || step.tool === 'look') { pushRead(); continue }
    if (['choose', 'press_point', 'hover', 'reveal'].includes(step.tool)) keyContextRecorded = false
  }
  if (!out.some((step) => step.kind === 'open')) return []
  pushRead()
  return out
}
