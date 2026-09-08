import { useSyncExternalStore } from 'react'
import type { DesktopBindingDto, DesktopControlStatusDto } from '../../../shared/desktop.js'
import { api } from '../api.js'

export type DesktopSurface = 'browser' | 'computer'
export function hasDesktopGrant(control: DesktopControlStatusDto | null): boolean {
  return Boolean(control && ['ready', 'running', 'needs-person'].includes(control.state))
}
interface Snapshot {
  available: boolean | null
  controlSupported: boolean | null
  bindings: DesktopBindingDto[]
  control: DesktopControlStatusDto | null
  error: string
  surfaces: Record<string, DesktopSurface>
}
let snapshot: Snapshot = { available: null, controlSupported: null, bindings: [], control: null, error: '', surfaces: {} }
const listeners = new Set<() => void>()
let unlisten: (() => void) | undefined
let polling: ReturnType<typeof setInterval> | undefined
let revision = 0
const surfaceRequests = new Map<string, number>()

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
    if (!available) { publish({ available: false, controlSupported: false, bindings: [], control: { state: 'idle' }, error: '' }); return }
    const [bindings, control, settings, engines] = await Promise.all([api.desktopBindings(), api.desktopControlStatus(), api.settingsGet(), api.engines()])
    const engine = engines.find((item) => item.id === settings.defaultEngine) ?? (engines.length === 1 && engines[0]?.id === 'mock' ? engines[0] : undefined)
    const controlSupported = Boolean(engine?.installed && engine.loggedIn && engine.desktopToolIsolation === true)
    if (request === revision) publish({ available, controlSupported, bindings, control, error: '' })
  } catch (error) {
    if (request === revision) publish({ controlSupported: false, error: desktopError(error) })
  }
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    unlisten = api.onEvent((event) => {
      if (event.type === 'settings:changed' || event.type === 'engines:changed' || event.type === 'engines:detected') { publish({ controlSupported: null }); void refreshDesktop() }
      else if (event.type === 'desktop:changed') void refreshDesktop()
      // The banner follows the hand-over itself, not the next poll.
      else if (event.type === 'desktop:control') publish({ control: event.control })
    })
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
  const request = (surfaceRequests.get(lane) ?? 0) + 1
  surfaceRequests.set(lane, request)
  const apply = () => {
    if (surfaceRequests.get(lane) === request && snapshot.surfaces[lane] !== surface) publish({ surfaces: { ...snapshot.surfaces, [lane]: surface } })
  }
  const binding = snapshot.bindings.find((item) => item.lane === lane)
  if (surface === 'browser' && binding && (binding.readable || (snapshot.control?.lane === lane && hasDesktopGrant(snapshot.control)))) {
    void api.desktopReadAccess(lane, false).then(() => { apply(); void refreshDesktop() }).catch((error: unknown) => {
      if (surfaceRequests.get(lane) === request) publish({ error: desktopError(error) })
    })
  } else apply()
}
export function useDesktopSurface(lane: string): DesktopSurface {
  const state = useDesktopSession()
  return state.surfaces[lane] ?? (state.bindings.some((binding) => binding.lane === lane) ? 'computer' : 'browser')
}
export async function stopComputerControl(): Promise<void> {
  try { await api.desktopControlStop() }
  finally { await refreshDesktop() }
}
