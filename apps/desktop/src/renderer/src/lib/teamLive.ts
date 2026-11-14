import { useSyncExternalStore } from 'react'
import { api } from '../api.js'
import { activeTeams, type TeamView } from './teamView.js'

let teams = new Map<string, TeamView>()
let loaded = false
let busy = false
let again = false
let wired = false
const listeners = new Set<() => void>()

function apply(next: Map<string, TeamView>): void {
  loaded = true
  let changed = next.size !== teams.size
  for (const [botId, view] of next) {
    const old = teams.get(botId)
    if (old && JSON.stringify(old) === JSON.stringify(view)) next.set(botId, old)
    else changed = true
  }
  if (!changed) return
  teams = next
  for (const listener of listeners) listener()
}

// One read at a time; events during a read collapse into one trailing read, so the last data always wins.
async function load(): Promise<void> {
  if (busy) { again = true; return }
  busy = true
  const next = await api.tasksList().then(activeTeams).catch(() => null)
  busy = false
  if (next) apply(next)
  if (again) { again = false; void load() }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (!wired) {
    wired = true
    api.onEvent((event) => { if (event.type === 'tasks:changed' || event.type === 'vault:ready') void load() })
  }
  if (!loaded && !busy) void load()
  return () => { listeners.delete(listener) }
}

export const teamStore = { subscribe, get: (botId: string): TeamView | undefined => teams.get(botId) }
export const useTeam = (botId: string): TeamView | undefined => useSyncExternalStore(subscribe, () => teams.get(botId))
