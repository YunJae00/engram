import type { AgentTool, AgentToolContext } from './agent-loop.js'

/** `tool`, ending the turn when `close` turns its reply into the person's answer: the model writes no second turn. Any other reply
 * (no answer, an empty one, a stop) goes to the model as before. */
export function closingTool(tool: AgentTool, close: (out: string, args: Record<string, unknown>, context: AgentToolContext) => Promise<string | undefined>): AgentTool {
  const written = new Set<string>()
  const run = async (args: Record<string, unknown>, context: AgentToolContext): Promise<string> => {
    const out = await tool.run(args, context)
    if (context.signal?.aborted) return out
    const text = await close(out, args, context)
    if (!text?.trim() || context.signal?.aborted) return out
    written.add(text)
    return text
  }
  const rest: AgentTool = { ...tool }
  delete rest.runRich
  return { ...rest, closes: true, closesOn: observation => written.has(observation), run }
}
