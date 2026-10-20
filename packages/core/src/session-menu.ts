import type { AgentTool } from './agent-loop.js'

// The tools a session is offered. Every tool description travels with every
// request, and a menu with near-twins costs reading time and wrong picks, so
// a tool whose job another offered tool also does stays off the menu:
// single page moves go through page_steps, finding a window or an app
// through app_read and open_app, open workbooks through excel_read and a
// timed wait through verify. Without its fuller twin a tool stays on.
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
