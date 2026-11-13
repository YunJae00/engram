import type { DesktopNodeDto, DesktopObservationDto, QuietObservationDto } from '../shared/desktop.js'

// The settle core lives in desktop-guarded-sequence.ts: plain-node fixtures load that file without a bundler, so it cannot import this one.
import { settle, observationKey, STILL_CHANGING, type Settled } from './desktop-guarded-sequence.js'
export { CAP_MS, observationKey, POLL_MS, settle, STILL_CHANGING, type Settled } from './desktop-guarded-sequence.js'

export const NO_EFFECT = 'The click showed no visible change, also after one retry. Say it did not work; do not click it again.'
export const TARGET_MOVING = 'The target kept moving. Read the app again before clicking.'
export const TARGET_LOST = 'The target moved and could not be found again. Read the app again.'
export function quietKey(view: QuietObservationDto): string {
  return JSON.stringify([view.bounds ?? null, view.controls.map(control => [control.type, control.name, control.value ?? null, control.state ?? null]), view.texts.map(text => text.text)])
}

function locate(view: DesktopObservationDto, node: DesktopNodeDto): DesktopNodeDto | undefined {
  const matches = view.nodes.filter(one => one.name === node.name && one.controlType === node.controlType && (!one.runtimeId || !node.runtimeId || one.runtimeId === node.runtimeId))
  return matches.length === 1 ? matches[0] : undefined
}

// A click's effect is any visible change except controls only changing position (a missed click on a shifting target).
function effectKey(view: DesktopObservationDto): string {
  return JSON.stringify([view.bounds, view.focusedControl ?? null, view.nodes.map(node => [node.name, node.controlType, node.value ?? null, node.enabled ?? null, node.offscreen ?? null])])
}

export interface ClickDeps {
  views: DesktopObservationDto[]
  element: string
  read: () => Promise<DesktopObservationDto>
  click: (view: DesktopObservationDto, element: string) => Promise<unknown>
  mayRetry: (node: DesktopNodeDto) => boolean
  signal?: AbortSignal
}
export interface ClickResult { view: DesktopObservationDto; clicks: number; settled: boolean; effect: boolean; retried: boolean; message?: string; error?: unknown }

export async function clickSettled(deps: ClickDeps): Promise<ClickResult> {
  const options = deps.signal ? { signal: deps.signal } : {}
  let view = deps.views.at(-1)!
  let node = view.nodes.find(one => one.id === deps.element)
  const prior = node && deps.views.length > 1 ? locate(deps.views.at(-2)!, node) : undefined
  if (node && prior && JSON.stringify(prior.bounds) !== JSON.stringify(node.bounds)) {
    const moving = await settle(deps.read, observationKey, options)
    view = moving.view
    if (!moving.settled) return { view, clicks: 0, settled: false, effect: false, retried: false, message: TARGET_MOVING }
    node = locate(view, node)
    if (!node) return { view, clicks: 0, settled: true, effect: false, retried: false, message: TARGET_LOST }
  }
  await deps.click(view, node?.id ?? deps.element)
  let clicks = 1
  let retried = false
  try {
    for (;;) {
      const after = await settle(deps.read, observationKey, options)
      if (!after.settled) return { view: after.view, clicks, settled: false, effect: false, retried, message: STILL_CHANGING }
      if (!node) return { view: after.view, clicks, settled: true, effect: observationKey(after.view) !== observationKey(view), retried }
      // Clicking the editor that already has focus changes nothing visible, and that is not a miss.
      if (view.focusedEditable === true && node.runtimeId && view.focusedControl === node.runtimeId) return { view: after.view, clicks, settled: true, effect: false, retried }
      if (effectKey(after.view) !== effectKey(view)) return { view: after.view, clicks, settled: true, effect: true, retried }
      const again = await settle(deps.read, observationKey, options)
      if (!again.settled) return { view: again.view, clicks, settled: false, effect: false, retried, message: STILL_CHANGING }
      if (effectKey(again.view) !== effectKey(view)) return { view: again.view, clicks, settled: true, effect: true, retried }
      const target = locate(again.view, node)
      if (retried || !target || !deps.mayRetry(node)) return { view: again.view, clicks, settled: true, effect: false, retried, message: NO_EFFECT }
      retried = true
      view = again.view
      node = target
      await deps.click(view, node.id)
      clicks++
    }
  } catch (error) {
    deps.signal?.throwIfAborted()
    return { view, clicks, settled: false, effect: false, retried, error }
  }
}

export interface ScrollDeps {
  delta: number
  snapshot: string
  since?: DesktopObservationDto
  read: () => Promise<DesktopObservationDto>
  scroll: (snapshot: string, sign: 1 | -1) => Promise<unknown>
  signal?: AbortSignal
}
export interface ScrollResult { view?: DesktopObservationDto; steps: number; settled: boolean; reachedEnd: boolean; message?: string; error?: unknown }

// Each step is one visible page natively, then a settle; a request of N pages never becomes one jump.
export async function scrollPages(deps: ScrollDeps): Promise<ScrollResult> {
  const sign = deps.delta < 0 ? -1 : 1
  let view = deps.since
  let snapshot = deps.snapshot
  for (let step = 0; step < Math.abs(deps.delta); step++) {
    try { await deps.scroll(snapshot, sign) }
    catch (error) {
      if (step === 0 || deps.signal?.aborted) throw error
      return { ...(view ? { view } : {}), steps: step, settled: false, reachedEnd: false, error }
    }
    let after: Settled<DesktopObservationDto>
    try { after = await settle(deps.read, observationKey, deps.signal ? { signal: deps.signal } : {}) }
    catch (error) {
      deps.signal?.throwIfAborted()
      return { ...(view ? { view } : {}), steps: step + 1, settled: false, reachedEnd: false, error }
    }
    if (!after.settled) return { view: after.view, steps: step + 1, settled: false, reachedEnd: false, message: STILL_CHANGING }
    if (view && observationKey(after.view) === observationKey(view)) {
      // A page that starts redrawing after the first pass is not the end; one more pass confirms it.
      try { after = await settle(deps.read, observationKey, deps.signal ? { signal: deps.signal } : {}) }
      catch (error) {
        deps.signal?.throwIfAborted()
        return { view, steps: step + 1, settled: false, reachedEnd: false, error }
      }
      if (!after.settled) return { view: after.view, steps: step + 1, settled: false, reachedEnd: false, message: STILL_CHANGING }
      if (observationKey(after.view) === observationKey(view)) return { view: after.view, steps: step + 1, settled: true, reachedEnd: true }
    }
    view = after.view
    snapshot = after.view.snapshot
  }
  return { ...(view ? { view } : {}), steps: Math.abs(deps.delta), settled: true, reachedEnd: false }
}
