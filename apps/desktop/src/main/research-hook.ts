import { pageDoTool, type GateMode, type PageDoStep } from 'core'
import { appCourier } from './app-courier.js'
import { decideChoice } from './decision-provider.js'

interface ResearchRun { url: string; goal: string; text?: string; maxSteps?: number; lane: string; gate?: GateMode; margin?: number; explore?: boolean; replay?: boolean }
interface ResearchResult { result: string; trace: PageDoStep[]; ms: number }

export function exposeResearch(): void {
  if (process.env['ENGRAM_RESEARCH'] !== '1') return
  const pageDo = async (input: ResearchRun): Promise<ResearchResult> => {
    const courier = appCourier({ lane: input.lane })
    await courier.fetchPage(input.url)
    const trace: PageDoStep[] = []
    const tool = pageDoTool(courier, (state, instructions, criteria, signal) => decideChoice(state, instructions, criteria, undefined, signal), { trace: step => trace.push(step), ...(input.gate ? { gate: input.gate } : {}), ...(input.margin ? { gateMargin: input.margin } : {}), ...(input.explore ? { gateExplore: true } : {}), ...(input.replay === false ? { gateReplay: false } : {}) })
    if (!tool) throw new Error('This browser cannot be driven step by step.')
    const started = Date.now()
    const result = await tool.run({ goal: input.goal, ...(input.text ? { text: input.text } : {}), ...(input.maxSteps ? { maxSteps: input.maxSteps } : {}) }, { task: input.goal, steps: [], read: '' })
    return { result: String(result), trace, ms: Date.now() - started }
  }
  Object.assign(globalThis, { __engramResearch: { pageDo } })
}
