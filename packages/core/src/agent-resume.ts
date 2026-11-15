import type { AgentLoopResult } from './agent-loop.js'
import { withoutSecretsIn } from './secrets.js'
import { contextExcerpt } from './context-excerpt.js'

// The checkpoint's own field names, which the resume prompt refers to.
export const RESUME_FIELDS: readonly string[] = ['at', 'request', 'remaining', 'lastResponse', 'collection', 'committedActions', 'recentResults', 'tool', 'args', 'observation']

// Historical context, not an executable plan or permission to resume input.
export function resumeCheckpoint(task: string, result: AgentLoopResult): string | undefined {
  return JSON.stringify(withoutSecretsIn({
    at: new Date().toISOString(),
    request: contextExcerpt(task, 6000),
    remaining: result.incomplete ?? result.pending ?? (result.asked ? 'Waiting for the person’s answer.' : result.stopped ? `Stopped: ${result.stopped}.` : 'No pending work reported. Do not repeat completed actions.'),
    lastResponse: contextExcerpt(result.answer, 8000),
    collection: result.steps.filter(step => step.tool === 'collect_results' && !step.observation.startsWith('that did not work:')).at(-1)?.observation,
    committedActions: result.steps.filter(step => step.committed).map(step => ({ tool: step.tool, args: step.args })),
    recentResults: result.steps.filter(step => !step.seeded).slice(-8).map(step => ({ tool: step.tool, observation: contextExcerpt(step.observation, 3000) })),
  }, [task, result.answer, ...result.steps.map(step => step.observation)].join('\n'), RESUME_FIELDS))
}
