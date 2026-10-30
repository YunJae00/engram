import type { AgentLoopStep, AgentTool } from './agent-loop.js'
import { officeReadEvidence } from './office-verification.js'

// Fresh readings of the world: what a phase can be shown done by.
const READS = new Set(['app_read', 'app_text', 'read_desktop', 'look_desktop', 'read_open_page', 'read_note', 'look', 'open_page', 'search_web', 'search_memory', 'outlook_mail', 'outlook_read', 'outlook_calendar', 'find_files', 'schedule', 'desk_activity', 'notifications', 'search_chats', 'look_in_parallel'])
function hasObservation(step: AgentLoopStep, allowFailure = false): boolean {
  if (step.tool === 'read_pages') return /^Batch read:/.test(step.observation)
  if (officeReadEvidence(step)) return true
  if (step.tool === 'read_live_document' || step.tool === 'edit_live_document') {
    try {
      const result = JSON.parse(step.observation) as { error?: unknown; live?: boolean; blocks?: unknown[]; completed?: unknown[]; completeReadback?: boolean }
      return result.live === true && !result.error && (Array.isArray(result.blocks) || (result.completeReadback === true && Array.isArray(result.completed) && result.completed.length > 0))
    } catch { return false }
  }
  if (step.tool.startsWith('file_')) {
    try {
      const result = JSON.parse(step.observation) as { sha256?: unknown; error?: unknown; truncated?: boolean; completeReadback?: boolean }
      const fullOutput = ['file_create_copy', 'file_create_workbook', 'file_edit_package'].includes(step.tool) && result.completeReadback === true
      return !result.error && (result.truncated !== true || fullOutput) && typeof result.sha256 === 'string' && /^[0-9a-f]{64}$/.test(result.sha256)
    } catch { return false }
  }
  if (READS.has(step.tool)) return !!step.observation.trim() && !/^that did not work:/.test(step.observation)
  if (step.tool !== 'desktop_action' && step.tool !== 'desktop_sequence') return false
  try {
    const result = JSON.parse(step.observation) as { error?: unknown; observation?: { snapshot?: unknown }; observationMayBeStale?: boolean }
    return (allowFailure || !result.error) && !result.observationMayBeStale && typeof result.observation?.snapshot === 'string' && !!result.observation.snapshot
  } catch { return false }
}
// The latest step that is not a plan call: a rejected or accepted plan call
// is bookkeeping, and must not stand between the work and its citation.
function latestWork(steps: AgentLoopStep[]): number {
  for (let at = steps.length; at > 0; at--) if (steps[at - 1]!.tool !== 'task_plan') return at
  return 0
}
export function taskPlan(steps: AgentLoopStep[]): { tool: AgentTool; completed: () => number; pending: () => string | undefined } {
  let phases: string[] = []
  let completed = 0
  let boundary = 0
  return {
    completed: () => completed,
    pending: () => phases.length > completed ? `Unverified phase ${completed + 1}/${phases.length}: ${phases[completed]}` : undefined,
    tool: {
      name: 'task_plan',
      description: 'For multi-stage work, define 2 to 8 outcome-based phases from the request, not a fixed click script. Create once with phases. Complete the current phase with evidenceStep (the numbered fresh observation after its work) and finding (what that observation confirms). If a fresh observation changes the approach, supply remainingPhases with evidenceStep and finding to revise only unfinished work, preserving all requested outcomes and restrictions. Revision earns no extra calls and never marks work complete. This records your assessment, not an independent proof. Never complete from input delivery, an error, or a guessed result. Plans do not authorize additional actions. If blocked, call ask_person with the barrier and what the person needs to provide, then stop and wait. Do not mark that phase complete.',
      argsSchema: { type: 'object', additionalProperties: false, properties: {
        phases: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 240 } },
        remainingPhases: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 240 } },
        evidenceStep: { type: 'integer', minimum: 1 }, finding: { type: 'string', minLength: 1, maxLength: 600 },
      }, oneOf: [{ required: ['phases'], maxProperties: 1 }, { required: ['evidenceStep', 'finding'], maxProperties: 2 }, { required: ['remainingPhases', 'evidenceStep', 'finding'], maxProperties: 3 }] },
      async run(given, context) {
        context.signal?.throwIfAborted()
        // Fields sent empty are fields not sent.
        const args = Object.fromEntries(Object.entries(given).filter(([, value]) => value !== null && value !== undefined))
        if (Object.keys(args).length === 1 && Array.isArray(args['phases'])) {
          if (phases.length) throw new Error(`The plan already has ${phases.length} phases. Complete the current one with evidenceStep and finding, or revise with remainingPhases.`)
          // A phase written as an object (a title with its check) is its words.
          const value = (args['phases'] as unknown[]).map(one => (typeof one === 'string' ? one : one && typeof one === 'object' ? Object.values(one).filter(part => typeof part === 'string').join(' - ') : '').trim().slice(0, 240))
          if (value.length < 2 || value.length > 8 || value.some(one => !one)) throw new Error(`Create one plan with 2 to 8 nonempty phases; ${value.length} were given${value.some(one => !one) ? ', some empty' : ''}.`)
          phases = value
          boundary = steps.length
        } else {
          const evidence = args['evidenceStep'], finding = args['finding']
          const revising = Object.hasOwn(args, 'remainingPhases')
          if (Object.keys(args).length !== (revising ? 3 : 2) || !Number.isInteger(evidence) || typeof evidence !== 'number' || typeof finding !== 'string' || !finding.trim() || finding.length > 600) throw new Error('Supply evidenceStep and a nonempty finding of at most 600 characters.')
          const step = steps[evidence - 1], latest = latestWork(steps)
          if (!phases.length) throw new Error('There is no plan in this turn yet: create one with phases first, then complete its phases.')
          if (completed >= phases.length) throw new Error('Every phase of the plan is already complete.')
          if (latest <= boundary) throw new Error('Nothing has been read since the last checkpoint: read a fresh result of this phase (a page, mail, file, search or app reading), then cite that step.')
          if (!hasObservation(steps[latest - 1]!, revising)) throw new Error(`Cite step ${latest}, the latest, only once it is a fresh result you read - a page, mail, file, search or app reading, not an error, a write or an input acknowledgement. Read the result first.`)
          if (evidence !== latest || !step) throw new Error(`Cite step ${latest}, the latest reading.`)
          if (revising) {
            const remaining = args['remainingPhases']
            if (!Array.isArray(remaining) || !remaining.length || completed + remaining.length > 8 || remaining.some((one) => typeof one !== 'string' || !one.trim() || one.length > 240)) throw new Error('Keep 1 to 8 unfinished phases within the 8-phase total, each nonempty and at most 240 characters.')
            phases = [...phases.slice(0, completed), ...remaining.map((one: string) => one.trim())]
          } else completed++
          boundary = steps.length
        }
        return JSON.stringify({ completed, total: phases.length, current: phases[completed] ?? null, remaining: phases.slice(completed), verification: 'model-assessed from cited observation' })
      },
    },
  }
}
