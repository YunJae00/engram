import { expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { sessionMenu } from '../src/session-menu.js'

const tool = (name: string): AgentTool => ({ name, description: name, argsSchema: {}, run: async () => '' })
const names = (tools: AgentTool[]) => tools.map(one => one.name)

it('leaves a tool off the menu only when the tool that also does its job is offered', () => {
  expect(names(sessionMenu(['open_page', 'press', 'type_text', 'page_steps', 'list_windows', 'app_read', 'wait_for', 'verify'].map(tool))))
    .toEqual(['open_page', 'page_steps', 'app_read', 'verify'])
  expect(names(sessionMenu(['press', 'type_text', 'list_windows', 'list_apps', 'excel_workbooks'].map(tool))))
    .toEqual(['press', 'type_text', 'list_windows', 'list_apps', 'excel_workbooks'])
})
