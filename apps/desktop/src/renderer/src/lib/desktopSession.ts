import { useSyncExternalStore } from 'react'
import type { DesktopBindingDto, DesktopControlStatusDto } from '../../../shared/desktop.js'
import { api } from '../api.js'

export type DesktopSurface = 'browser' | 'computer'
export function hasDesktopGrant(control: DesktopControlStatusDto | null): boolean {
  return Boolean(control && ['ready', 'running', 'needs-person'].includes(control.state))
}
interface Snapshot {
  available: boolean | null
  bindings: DesktopBindingDto[]
  control: DesktopControlStatusDto | null
  error: string
  surfaces: Record<string, DesktopSurface>
}
let snapshot: Snapshot = { available: null, bindings: [], control: null, error: '', surfaces: {} }
const listeners = new Set<() => void>()
let unlisten: (() => void) | undefined
let polling: ReturnType<typeof setInterval> | undefined
let revision = 0

function publish(next: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...next }
  for (const listener of listeners) listener()
}
export function desktopError(error: unknown): string {
  return error instanceof Error ? error.message : 'Computer access could not be updated. Try again.'
}
export async function refreshDesktop(): Promise<void> {
  const request = ++revision
  try {
    const available = await api.desktopAvailable()
    if (request !== revision) return
    if (!available) { publish({ available: false, bindings: [], control: { state: 'idle' }, error: '' }); return }
    const [bindings, control] = await Promise.all([api.desktopBindings(), api.desktopControlStatus()])
    if (request === revision) publish({ available, bindings, control, error: '' })
  } catch (error) {
    if (request === revision) publish({ error: desktopError(error) })
  }
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    unlisten = api.onEvent((event) => { if (event.type === 'desktop:changed') void refreshDesktop() })
    void refreshDesktop()
    polling = setInterval(() => {
      if (snapshot.control && snapshot.control.state !== 'idle') void refreshDesktop()
    }, 2000)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) { unlisten?.(); unlisten = undefined; clearInterval(polling); polling = undefined; revision++ }
  }
}
export function useDesktopSession(): Snapshot { return useSyncExternalStore(subscribe, () => snapshot) }
export function selectDesktopSurface(lane: string, surface: DesktopSurface): void {
  if (snapshot.surfaces[lane] !== surface) publish({ surfaces: { ...snapshot.surfaces, [lane]: surface } })
}
export function useDesktopSurface(lane: string): DesktopSurface {
  const state = useDesktopSession()
  return state.surfaces[lane] ?? (state.bindings.some((binding) => binding.lane === lane) ? 'computer' : 'browser')
}
export async function stopComputerControl(): Promise<void> {
  try { await api.desktopControlStop() }
  finally { await refreshDesktop() }
}
