import type { DevItem } from '../shared/developers.js'

export function devActivity(name: string, input: Record<string, unknown>): Pick<DevItem, 'title' | 'activity'> {
  const action = Array.isArray(input['commandActions']) ? input['commandActions'][0] : undefined
  if (action?.type === 'read') return devActivity('Read', { path: action.path })
  if (action?.type === 'search' || action?.type === 'listFiles') return { title: action.type === 'search' ? 'Search files' : 'List files', activity: 'search' }
  const changed = Array.isArray(input['changes']) ? input['changes'][0]?.path : undefined
  const path = typeof input['file_path'] === 'string' ? input['file_path'] : typeof input['path'] === 'string' ? input['path'] : typeof changed === 'string' ? changed : ''
  const file = path.split(/[\\/]/).at(-1)
  if (['Bash', 'Shell', 'commandExecution'].includes(name)) return { title: typeof input['description'] === 'string' && input['description'].trim() ? input['description'].trim().slice(0, 100) : 'Command', activity: 'command' }
  if (['Read', 'Edit', 'Write', 'MultiEdit', 'fileChange'].includes(name)) return { title: `${name === 'Read' ? 'Read' : name === 'Write' ? 'Write' : 'Edit'}${file ? ` · ${file}` : ' files'}`, activity: 'file' }
  if (['Grep', 'Glob', 'LS', 'webSearch'].includes(name)) return { title: 'Search', activity: 'search' }
  if (['Agent', 'Task', 'collabAgentToolCall', 'subAgentActivity'].includes(name)) return { title: 'Agent task', activity: 'agent' }
  if (['TodoWrite', 'plan'].includes(name)) return { title: 'Plan', activity: 'plan' }
  return { title: name.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Tool', activity: 'tool' }
}
