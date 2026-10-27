import { runComet, type AgentTool } from 'core'
import { resetLane } from './agent-browser.js'

// A helper looks into one question on a tab of its own and only reads: the
// web, the person's notes and earlier conversations. Its tab is closed when
// it is done; what it found goes back to the comet that asked.
const HELPER_READS = new Set(['search_web', 'open_page', 'read_open_page', 'read_pages', 'look', 'scroll', 'reveal', 'search_memory', 'read_note', 'search_chats', 'find_skills', 'open_skill'])
const HELPER_CALLS = 30
const HELPER_PERSONA = 'You are a helper looking into one question for a colleague who does the rest of the work. Only read. Bring back what you found, briefly, with the addresses it came from, and say plainly what you could not find.'

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
