import type { AgentLoopResult } from './agent-loop.js'
import { withoutSecrets } from './secrets.js'

// Historical context, not an executable plan or permission to resume input.
export function resumeCheckpoint(task: string, result: AgentLoopResult): string | undefined {
  if (!result.incomplete && !result.stopped && !result.asked && !result.pending) return
  return withoutSecrets(JSON.stringify({
    request: task.slice(0, 2000),
    remaining: (result.incomplete ?? result.pending ?? (result.asked ? 'Waiting for the person’s answer.' : `Stopped: ${result.stopped}.`)).slice(0, 2000),
    lastResponse: result.answer.slice(-2500),
    recentResults: result.steps.filter(step => !step.seeded).slice(-3).map(step => ({ tool: step.tool, observation: step.observation.slice(0, 1000) })),
  }), [task, result.answer, ...result.steps.map(step => step.observation)].join('\n'))
}
