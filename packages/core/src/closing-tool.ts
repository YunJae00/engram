import type { AgentTool, AgentToolContext } from './agent-loop.js'

/** What a closing call leaves: `said` is the call's reply (its step), `answer` the person's answer the turn ends on. */
export interface Closing { said: string; answer: string }

/** `tool`, ending the turn when `close` turns its reply into the person's answer: the model writes no second turn. Any other reply
 * (no answer, an empty one, a stop) goes to the model as before. A plain string is both the reply and the answer. */
export function closingTool(tool: AgentTool, close: (out: string, args: Record<string, unknown>, context: AgentToolContext) => Promise<string | Closing | undefined>): AgentTool {
  const answers = new Map<string, string>()
  const run = async (args: Record<string, unknown>, context: AgentToolContext): Promise<string> => {
    const out = await tool.run(args, context)
    if (context.signal?.aborted) return out
    const done = await close(out, args, context), closing = typeof done === 'string' ? { said: done, answer: done } : done
    if (!closing?.answer.trim() || context.signal?.aborted) return out
    answers.set(closing.said, closing.answer)
    return closing.said
  }
  const rest: AgentTool = { ...tool }
  delete rest.runRich
  return { ...rest, closes: true, closesOn: observation => answers.has(observation), closeAnswer: observation => answers.get(observation), run }
}
