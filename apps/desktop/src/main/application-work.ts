import { screen } from 'electron'
import { DesktopHost } from './desktop-host.js'
import { hideControlOverlay, overlayStatus, prepareControlOverlay, updateControlOverlay } from './desktop-overlay.js'
import type { DesktopControlStatusDto } from '../shared/desktop.js'
import { cancelDesktopTurn } from './desktop-control.js'

type Bounds = { x: number; y: number; width: number; height: number }
type WindowInfo = { window: string; pid: number; minimized: boolean; foreground: boolean; bounds: Bounds; visualBounds?: Bounds }
type Activity = { lane: string; controller: AbortController; host: DesktopHost; revision: number; timer?: ReturnType<typeof setTimeout>; target?: WindowInfo; name?: string; status?: DesktopControlStatusDto }
let active: Activity | undefined

export function clearApplicationWork(lane?: string): void {
  if (!active || (lane && active.lane !== lane)) return
  clearTimeout(active.timer)
  active.controller.abort(new Error('Application work ended. Check any partial changes before continuing.'))
  active.host.close()
  active = undefined
  if (overlayStatus().application) hideControlOverlay()
}

export function stopApplicationWork(reason = 'You stopped application work.'): boolean {
  if (!active || !overlayStatus().application) return false
  cancelDesktopTurn(active.lane, reason)
  active.controller.abort(new Error(`${reason} Changes may be partial; read the document before continuing.`))
  clearTimeout(active.timer)
  active.host.close()
  hideControlOverlay()
  return true
}

function applicationStatus(held: Activity, target: WindowInfo): DesktopControlStatusDto {
  const visibleBounds = target.visualBounds ?? target.bounds
  if (!visibleBounds || !Object.values(visibleBounds).every(Number.isFinite) || visibleBounds.width <= 0 || visibleBounds.height <= 0) throw new Error('The application window has no valid bounds')
  const rect = Object.fromEntries(Object.entries(visibleBounds).map(([key, value]) => [key, Math.round(value)])) as Bounds
  const bounds = target.minimized && held.status?.application ? held.status.application.bounds : screen.screenToDipRect(null, rect)
  return { state: 'running', lane: held.lane, inputActive: false, application: { name: held.name ?? 'the application', bounds, visible: !target.minimized } }
}

async function track(held: Activity, revision: number): Promise<void> {
  if (active !== held || held.revision !== revision || held.controller.signal.aborted || !held.target) return
  const shown = overlayStatus()
  if (shown.state === 'running' && !shown.application) { clearApplicationWork(held.lane); return }
  try {
    const input = await held.host.request<{ escaped: boolean }>('inputState', {})
    if (active !== held || held.revision !== revision) return
    if (input.escaped) { stopApplicationWork(); return }
    const target = await held.host.request<WindowInfo>('inspectWindow', { window: held.target.window, pid: held.target.pid })
    if (active !== held || held.revision !== revision || held.controller.signal.aborted) return
    const status = applicationStatus(held, target)
    if (JSON.stringify(status) !== JSON.stringify(held.status)) { held.status = status; updateControlOverlay(status) }
    held.timer = setTimeout(() => void track(held, revision), 16)
  } catch {
    if (active === held && held.revision === revision) stopApplicationWork('The application window could no longer be verified.')
  }
}

export function applicationWork(lane: string, signal?: AbortSignal): { signal: AbortSignal; show(window: string, name: string): Promise<void> } {
  const shown = overlayStatus()
  if (shown.state === 'running' && !shown.application) throw new Error('Another computer-control operation is using the screen. Wait for it to finish.')
  if (active && active.lane !== lane) clearApplicationWork()
  active ??= { lane, controller: new AbortController(), host: new DesktopHost(), revision: 0 }
  const held = active
  const combined = signal ? AbortSignal.any([signal, held.controller.signal]) : held.controller.signal
  combined.throwIfAborted()
  return {
    signal: combined,
    show: async (window, name) => {
      combined.throwIfAborted()
      clearTimeout(held.timer)
      const revision = ++held.revision
      let target = await held.host.request<WindowInfo>('inspectWindow', { window, pid: 0 })
      combined.throwIfAborted()
      const entering = held.target?.window !== target.window || held.target.pid !== target.pid
      if (entering && (!target.foreground || target.minimized)) target = await held.host.request<WindowInfo>('activateWindow', { window: target.window, pid: target.pid })
      combined.throwIfAborted()
      if (entering && (!target.foreground || target.minimized)) throw new Error('The application did not come to the foreground.')
      if (active !== held) throw new Error('Application work changed before the window was ready')
      held.target = target
      held.name = name
      held.status = applicationStatus(held, target)
      await prepareControlOverlay(held.status)
      combined.throwIfAborted()
      const input = await held.host.request<{ escaped: boolean }>('inputState', {})
      if (input.escaped) { stopApplicationWork(); combined.throwIfAborted() }
      await held.host.request<WindowInfo>('inspectWindow', { window: target.window, pid: target.pid })
      combined.throwIfAborted()
      // Document commands are bound to this verified window, not foreground input.
      held.timer = setTimeout(() => void track(held, revision), 16)
    },
  }
}
