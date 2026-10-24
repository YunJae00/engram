import { createHash } from 'node:crypto'
import type { TaskWatch } from 'core'
import { officeAgentTools } from './office-agent.js'
import { loadSettings } from './settings.js'

// Listings a kept request may look at by itself before it runs. They only
// read, so a look changes nothing and costs no model call.
export const WATCHABLE = ['outlook_mail', 'outlook_calendar']
const LOOK_MS = 60_000

function listed(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  if (typeof record['id'] === 'string') return [record]
  const inner = Object.values(record).find(one => Array.isArray(one) || (typeof one === 'object' && one !== null))
  return inner === undefined ? [] : listed(inner)
}

// One key per item: its id when the app gives one, else a digest of the item.
export function watchKeys(raw: string): { key: string; id?: string }[] {
  return listed(JSON.parse(raw)).map(item => {
    const id = typeof item === 'object' && item !== null ? (item as Record<string, unknown>)['id'] : undefined
    return typeof id === 'string' && id ? { key: id, id } : { key: createHash('sha1').update(JSON.stringify(item)).digest('hex') }
  })
}

// Null while the listing cannot be read: app work is off, the app is turned
// off in settings, or the app is not on this machine.
export async function peekWatch(watch: TaskWatch): Promise<{ key: string; id?: string }[] | null> {
  if (!WATCHABLE.includes(watch.tool)) return null
  const settings = await loadSettings()
  if (settings.computerUse !== true) return null
  const app = watch.tool.split('_')[0] ?? ''
  if (settings.appsOff.some(one => one.app.includes(app) || one.label.toLowerCase().includes(app))) return null
  const tool = officeAgentTools('standing-watch').find(one => one.name === watch.tool)
  if (!tool) return null
  return watchKeys(await tool.run(watch.args, { task: 'Look for new items', signal: AbortSignal.timeout(LOOK_MS) }))
}
