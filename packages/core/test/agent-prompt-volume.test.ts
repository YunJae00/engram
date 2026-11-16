import { describe, expect, it } from 'vitest'
import type { AgentTool } from '../src/agent-loop.js'
import { pickTools } from '../src/agent-prompt.js'

function tool(name: string): AgentTool {
  return { name, description: `Use ${name}`, argsSchema: { type: 'object', properties: {} }, run: async () => 'ok' }
}
const base = ['search_memory', 'read_note', 'find_procedure', 'propose_note', 'open_page', 'search_web', 'ask_person', 'list_apps', 'open_app', 'list_windows', 'app_read', 'app_text', 'read_desktop', 'look_desktop', 'desktop_action'].map(tool)
const tools = [...base, tool('system_volume'), tool('permission_state')]
const names = (all: AgentTool[], task: string): string[] => pickTools(all, task, []).map((one) => one.name)

describe('guided menu for system tools', () => {
  it('a volume request offers system_volume', () => {
    expect(names(tools, '음량 30%로 맞춰 줘')).toContain('system_volume')
    expect(names(tools, 'mute the sound')).toContain('system_volume')
    expect(names(tools, '소리 꺼 줘')).toContain('system_volume')
  })
  it('a permission question offers permission_state', () => {
    expect(names(tools, '권한 뭐 켜져 있어?')).toContain('permission_state')
    expect(names(tools, '권한 뭐 켜져 있어?')).not.toContain('system_volume')
  })
  it('a standing instruction or a notification ask offers teammate_settings past the menu cap', () => {
    const team = [...tools, tool('teammate_settings')]
    for (const task of ['앞으로 보고서는 금요일 정오까지 써', '알림 꺼줘', 'From now on write the Friday report by noon, and turn your notifications off.']) expect(names(team, task)).toContain('teammate_settings')
    expect(names(team, '카카오톡 열어 줘')).not.toContain('teammate_settings')
  })
  it('other desktop tasks keep their menu', () => {
    expect(names(tools, '카카오톡 열어 줘')).toEqual(names(base, '카카오톡 열어 줘'))
    expect(names(tools, '음량 30%로 맞춰 줘').slice(0, 5)).toEqual(names(base, '음량 30%로 맞춰 줘'))
  })
})
