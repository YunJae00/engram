import { collectionProgress } from './collection-progress.js'
import type { AgentLoopDeps, AgentLoopOptions } from './agent-loop.js'
import type { ToolSessionCall } from './engine/types.js'
import { desktopScopeTools, isDesktopTool } from './desktop-tools.js'
import { promptFor } from './prompt.js'
import { sessionMenu } from './session-menu.js'
import { taskPlan } from './agent-plan.js'

export function sessionShape(deps: Pick<AgentLoopDeps, 'engine' | 'tools'>, options: Pick<AgentLoopOptions, 'native'> = {}): { system: string; tools: Omit<ToolSessionCall, 'run'>[] } {
  const desktop = deps.tools.some((tool) => isDesktopTool(tool.name))
  const files = deps.tools.some((tool) => tool.name.startsWith('file_'))
  const workflow = desktop || files
  const browser = deps.tools.some(tool => tool.name === 'open_page')
  const planned = workflow || browser
  const scoped = sessionMenu(desktopScopeTools(deps.tools))
  const tools = [...scoped, ...(browser ? [collectionProgress([]).tool] : []), ...(planned && desktop ? [taskPlan([]).tool] : [])]
  return {
    system: promptFor('work', { task: '', flags: { engineId: deps.engine.id, desktop, workflow, browser, planned, pageSteps: scoped.some(tool => tool.name === 'page_steps'), pageDo: scoped.some(tool => tool.name === 'page_do'), native: options.native, tools: deps.tools.map(tool => tool.name) } }).system,
    tools: tools.map(tool => ({ name: tool.name, description: tool.description, argsSchema: tool.argsSchema })),
  }
}
