import type { AgentTool } from './agent-loop.js'

const FOLDED_INTO: Record<string, string> = {
  press: 'page_steps', type_text: 'page_steps', choose: 'page_steps', scroll: 'page_steps', hover: 'page_steps', press_key: 'page_steps',
  list_windows: 'app_read',
  list_apps: 'open_app',
  excel_workbooks: 'excel_read',
  wait_for: 'verify',
}

export function sessionMenu(tools: AgentTool[]): AgentTool[] {
  const offered = new Set(tools.map(tool => tool.name))
  return tools.filter(tool => !(tool.name in FOLDED_INTO && offered.has(FOLDED_INTO[tool.name]!)))
}
