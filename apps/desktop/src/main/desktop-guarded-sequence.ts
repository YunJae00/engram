import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopAction, DesktopGuardedAction } from 'core'
import type { DesktopObservationDto, DesktopNodeDto } from '../shared/desktop.js'

const geometry = (view: DesktopObservationDto) => JSON.stringify([view.bounds, view.captureBounds])

// ponytail: exact names need a complete view; use observed element editing for partial trees.
export async function guardedSequence(
  original: DesktopObservationDto, actions: DesktopGuardedAction[],
  read: () => Promise<DesktopObservationDto>, act: (action: DesktopAction) => Promise<unknown>, signal?: AbortSignal,
): Promise<string> {
  const started = performance.now()
  let observation = original
  let completed = 0
  let dispatched = 0
  let verified = 0
  let failedStep = 1
  let observationMayBeStale = false
  const identities = new Map<string, string>()
  const check = () => {
    signal?.throwIfAborted()
    if (performance.now() - started > 20000) throw new Error('Sequence time limit reached. Inspect the current state before continuing.')
    if (observation.truncated !== false || observation.captureSafe === false || observation.protectedBounds?.length) throw new Error('Named targets require a complete, unprotected observation. Use observed element editing for a partial view.')
    if (geometry(observation) !== geometry(original)) throw new Error('The app geometry changed. Inspect the current state before continuing.')
  }
  const targetOf = (step: DesktopGuardedAction): DesktopNodeDto | undefined => {
    check()
    const matches = observation.nodes.filter((node) => node.name === step.target.name && node.controlType === step.target.controlType
      && node.offscreen !== true && node.enabled !== false)
    if (matches.length > 1) throw new Error('The next target is ambiguous. Inspect the current state before continuing.')
    const node = matches[0]
    if (node && (node.password || node.isPassword)) throw new Error('Protected controls require the person.')
    if (node?.runtimeId) {
      const key = JSON.stringify(step.target)
      if (identities.has(key) && identities.get(key) !== node.runtimeId) throw new Error('The target was replaced. Inspect the current state before continuing.')
      identities.set(key, node.runtimeId)
    }
    return node
  }
  const refresh = async () => {
    observationMayBeStale = true
    observation = await read()
    observationMayBeStale = false
    check()
  }
  try {
    if (!actions.length || actions.length > 12 || !targetOf(actions[0]!)) throw new Error('Start with a target from the current observation, using 1 to 12 steps.')
    await refresh()
    for (const step of actions) {
      failedStep = completed + 1
      let node = targetOf(step)
      if (step.kind === 'verify') {
        const until = performance.now() + 2000
        while (!node || node.value !== step.value) {
          if (performance.now() >= until) throw new Error('The expected field value was not observed. Inspect the result; do not repeat the input.')
          await delay(80, undefined, { signal })
          await refresh()
          node = targetOf(step)
        }
        verified++
      } else {
        if (!node?.runtimeId) throw new Error('The next target is missing or has no stable identity. Inspect the current state before continuing.')
        if (step.kind !== 'click' && observation.focusedControl !== node.runtimeId) throw new Error('The intended control does not have keyboard focus. Inspect the current state before continuing.')
        if (step.kind === 'type' && (observation.focusedEditable !== true || node.actions?.type !== true)) throw new Error('The intended field is not editable.')
        const action: DesktopAction = step.kind === 'click' ? { kind: 'click', snapshot: observation.snapshot, element: node.id }
          : step.kind === 'type' ? { kind: 'type', snapshot: observation.snapshot, text: step.text }
            : { kind: 'key', snapshot: observation.snapshot, key: step.key }
        observationMayBeStale = true
        await act(action)
        dispatched++
        await refresh()
      }
      completed++
    }
    return JSON.stringify({ completed, dispatched, verified, elapsedMs: Math.round(performance.now() - started), observation, requiresVerification: true })
  } catch (error) {
    signal?.throwIfAborted()
    return JSON.stringify({ completed, dispatched, verified, failedStep, error: error instanceof Error ? error.message : String(error),
      elapsedMs: Math.round(performance.now() - started), observation, observationMayBeStale })
  }
}
