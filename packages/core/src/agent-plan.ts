import type { AgentLoopStep, AgentTool } from './agent-loop.js'

const READS = new Set(['read_desktop', 'look_desktop', 'read_open_page', 'read_note', 'look'])
function hasObservation(step: AgentLoopStep): boolean {
  if (READS.has(step.tool)) return !!step.observation.trim() && !/^that did not work:/.test(step.observation)
  if (step.tool !== 'desktop_action' && step.tool !== 'desktop_sequence') return false
  try {
    const result = JSON.parse(step.observation) as { error?: unknown; observation?: { snapshot?: unknown }; observationMayBeStale?: boolean }
    return !result.error && !result.observationMayBeStale && typeof result.observation?.snapshot === 'string' && !!result.observation.snapshot
  } catch { return false }
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
      description: 'For multi-stage work, define 2 to 8 outcome-based phases from the request, not a fixed click script. Create once with phases. Complete the current phase with evidenceStep (the numbered fresh observation after its work) and finding (what that observation confirms). This records your assessment, not an independent proof. Never complete from input delivery, an error, or a guessed result. Plans do not authorize additional actions. If blocked, leave the phase incomplete and report why.',
      argsSchema: { type: 'object', additionalProperties: false, properties: {
        phases: { type: 'array', minItems: 2, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 240 } },
        evidenceStep: { type: 'integer', minimum: 1 }, finding: { type: 'string', minLength: 1, maxLength: 600 },
      }, oneOf: [{ required: ['phases'] }, { required: ['evidenceStep', 'finding'] }] },
      async run(args, context) {
        context.signal?.throwIfAborted()
        if (Object.keys(args).length === 1 && Array.isArray(args['phases'])) {
          const value = args['phases']
          if (phases.length || value.length < 2 || value.length > 8 || value.some((one) => typeof one !== 'string' || !one.trim() || one.length > 240)) throw new Error('Create one plan with 2 to 8 nonempty phases, each at most 240 characters.')
          phases = value.map((one: string) => one.trim())
          boundary = steps.length
        } else {
          const evidence = args['evidenceStep'], finding = args['finding']
          if (Object.keys(args).length !== 2 || !Number.isInteger(evidence) || typeof evidence !== 'number' || typeof finding !== 'string' || !finding.trim() || finding.length > 600) throw new Error('Supply evidenceStep and a nonempty finding of at most 600 characters.')
          const step = steps[evidence - 1]
          if (!phases.length || completed >= phases.length || evidence <= boundary || evidence !== steps.length || !step || !hasObservation(step)) throw new Error('Complete the current phase only with the latest fresh result observation; input acknowledgements, errors and reused evidence do not count.')
          completed++
          boundary = steps.length
        }
        return JSON.stringify({ completed, total: phases.length, current: phases[completed] ?? null, verification: 'model-assessed from cited observation' })
      },
    },
  }
}
