import { HELPER_PERSONA, runComet, type AgentTool } from 'core'
import { resetLane } from './agent-browser.js'

const HELPER_READS = new Set(['search_web', 'open_page', 'read_open_page', 'read_pages', 'look', 'scroll', 'reveal', 'search_memory', 'read_note', 'search_chats', 'find_skills', 'open_skill'])
const HELPER_CALLS = 30

export const isHelperLane = (channel: string): boolean => /~look-\d+$/.test(channel)

type Deps = Parameters<typeof runComet>[0]

export async function lookAsHelper(input: {
  channel: string
  engine: Deps['engine']
  workdir: Deps['workdir']
  guided: boolean
  toolsFor(lane: string): Promise<AgentTool[]>
  onStep(line: string): void
}, question: string, index: number, signal?: AbortSignal): Promise<string> {
  const lane = `${input.channel}~look-${index + 1}`
  try {
    const tools = (await input.toolsFor(lane)).filter(tool => HELPER_READS.has(tool.name))
    const result = await runComet({ engine: input.engine, workdir: input.workdir, tools }, question, {
      ...(signal ? { signal } : {}),
      guided: input.guided,
      maxCalls: HELPER_CALLS,
      persona: HELPER_PERSONA,
      onStep: input.onStep,
    })
    return result.answer
  } finally {
    await resetLane(lane)
  }
}
