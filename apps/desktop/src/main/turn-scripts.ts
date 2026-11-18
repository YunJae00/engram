import { basename } from 'node:path'

const SHELLS = new Set(['Bash', 'PowerShell', 'Shell'])
const SCRIPT_FILE = /\.(ps1|psm1|py|js|mjs|cmd|bat|vbs)$/i
const SCRIPT_CAP = 20_000
const SCRIPTS_KEPT = 4

export interface TurnScript { name: string; text: string }
const byChannel = new Map<string, Map<string, TurnScript>>()

export function noteScript(channel: string, tool: string, input: Record<string, unknown>): void {
  const path = typeof input['file_path'] === 'string' ? input['file_path'] : ''
  const shell = SHELLS.has(tool)
  const text = shell ? input['command'] : tool === 'Write' && SCRIPT_FILE.test(path) ? input['content'] : undefined
  if (typeof text !== 'string' || !text.trim() || text.length > SCRIPT_CAP) return
  const scripts = byChannel.get(channel) ?? new Map<string, TurnScript>()
  const key = shell ? `${tool}:${text.trim().split('\n', 1)[0]!.slice(0, 80)}` : `file:${basename(path)}`
  scripts.delete(key)
  scripts.set(key, { name: shell ? (tool === 'Bash' ? 'command.sh' : 'command.ps1') : basename(path), text })
  while (scripts.size > SCRIPTS_KEPT) scripts.delete(scripts.keys().next().value!)
  byChannel.set(channel, scripts)
}

export function takeTurnScripts(channel: string): TurnScript[] {
  const scripts = [...(byChannel.get(channel)?.values() ?? [])]
  byChannel.delete(channel)
  const seen = new Map<string, number>()
  return scripts.map(script => {
    const count = (seen.get(script.name) ?? 0) + 1
    seen.set(script.name, count)
    return count === 1 ? script : { ...script, name: script.name.replace(/(\.[a-z0-9]+)$/i, `-${count}$1`) }
  })
}
