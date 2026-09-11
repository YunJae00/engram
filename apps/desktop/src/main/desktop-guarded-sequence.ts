import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopAction, DesktopGuardedAction } from 'core'
import type { DesktopObservationDto, DesktopNodeDto } from '../shared/desktop.js'

export function replacementTarget(view: DesktopObservationDto, element: string, expected: string): DesktopNodeDto {
  const matches = view.nodes.filter((node) => node.id === element)
  const node = matches[0]
  if (matches.length !== 1 || !node?.runtimeId || node.password || node.isPassword || node.enabled === false || node.offscreen === true
    || view.protectedBounds?.length || node.actions?.replace !== true || view.focusedEditable !== true || view.focusedControl !== node.runtimeId)
    throw new Error('Select an observed, focused field that supports replacement before replacing its contents.')
  if (node.valueTruncated !== false || typeof node.value !== 'string' || node.value !== expected)
    throw new Error('The complete current field value must match expected before replacement. Observe it again; do not overwrite changed content.')
  return node
}

const geometry = (view: DesktopObservationDto) => JSON.stringify([view.bounds, view.captureBounds])
const lines = (value?: string | null) => value?.replace(/\r\n?/g, '\n')

// ponytail: partial trees need explicit starting anchors; unseen controls require a complete view.
export async function guardedSequence(
  original: DesktopObservationDto, actions: DesktopGuardedAction[],
  read: (focusedOnly?: boolean) => Promise<DesktopObservationDto>, act: (action: DesktopAction) => Promise<unknown>, signal?: AbortSignal,
): Promise<string> {
  const started = performance.now()
  let observation = original
  let completed = 0
  let dispatched = 0
  let verified = 0
  let failedStep = 1
  let observationMayBeStale = false
  let focusedOnly = false
  const identities = new Map<string, string>()
  const anchors = new Map<string, string>()
  const check = () => {
    signal?.throwIfAborted()
    if (performance.now() - started > 20000) throw new Error('Sequence time limit reached. Inspect the current state before continuing.')
    // Focus reads do not authorize images. Native input still revalidates the
    // whole window before each packet; only this anchored path can use them.
    if (observation.protectedBounds?.length || (!(focusedOnly && observation.scope === 'focus')
      && (observation.captureSafe === false || (observation.truncated !== false && observation.captureSafe !== true)))) throw new Error('The observation could not be cleared for input.')
    if (geometry(observation) !== geometry(original)) throw new Error('The app geometry changed. Inspect the current state before continuing.')
  }
  const targetOf = (step: DesktopGuardedAction): DesktopNodeDto | undefined => {
    check()
    const anchor = step.target.element ? anchors.get(step.target.element) : undefined
    if (observation.truncated !== false && !anchor) throw new Error('A partial view requires target.element from the starting observation for every target.')
    const matches = observation.nodes.filter((node) => node.name === step.target.name && node.controlType === step.target.controlType
      && (!anchor || node.runtimeId === anchor) && node.offscreen !== true && node.enabled !== false)
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
    observation = await read(focusedOnly)
    observationMayBeStale = false
    check()
  }
  try {
    for (const step of actions) {
      if (original.truncated !== false && !step.target.element) throw new Error('A partial view requires target.element from the starting observation for every target.')
      if (!step.target.element) continue
      const nodes = original.nodes.filter((node) => node.id === step.target.element && node.name === step.target.name && node.controlType === step.target.controlType)
      const node = nodes[0]
      if (nodes.length !== 1 || !node?.runtimeId || node.password || node.isPassword || node.offscreen === true || node.enabled === false
        || original.nodes.filter((one) => one.runtimeId === node.runtimeId).length !== 1) throw new Error('Every anchor must identify one available, unprotected control in the starting observation.')
      anchors.set(step.target.element, node.runtimeId)
    }
    focusedOnly = original.focusedEditable === true && !!original.focusedControl
      && actions.every((step) => !!step.target.element && anchors.get(step.target.element) === original.focusedControl)
    if (!actions.length || actions.length > 12 || (!targetOf(actions[0]!) && actions[0]!.kind !== 'wait')) throw new Error('Start with an observed target or an explicit wait, using 1 to 12 steps.')
    await refresh()
    for (const step of actions) {
      failedStep = completed + 1
      let node = targetOf(step)
      if (step.kind === 'verify' || step.kind === 'wait') {
        const until = performance.now() + (step.kind === 'wait' ? 5000 : 2000)
        while (!node || (step.kind === 'verify' && (node.valueTruncated === true || lines(node.value) !== lines(step.value)))) {
          if (performance.now() >= until) throw new Error(step.kind === 'wait' ? 'The expected control did not become available. Inspect the state; do not repeat earlier actions.' : 'The expected field value was not observed. Inspect the result; do not repeat the input.')
          await delay(80, undefined, { signal })
          await refresh()
          node = targetOf(step)
        }
        if (step.kind === 'verify') verified++
      } else {
        if (!node?.runtimeId) throw new Error('The next target is missing or has no stable identity. Inspect the current state before continuing.')
        if (step.kind !== 'click' && observation.focusedControl !== node.runtimeId) throw new Error('The intended control does not have keyboard focus. Inspect the current state before continuing.')
        if (step.kind === 'type' && (observation.focusedEditable !== true || node.actions?.type !== true)) throw new Error('The intended field is not editable.')
        if (step.kind === 'replace') replacementTarget(observation, node.id, step.expected)
        const action: DesktopAction = step.kind === 'click' ? { kind: 'click', snapshot: observation.snapshot, element: node.id }
          : step.kind === 'type' ? { kind: 'type', snapshot: observation.snapshot, text: step.text }
            : step.kind === 'replace' ? { kind: 'replace', snapshot: observation.snapshot, element: node.id, expected: step.expected, text: step.text }
            : { kind: 'key', snapshot: observation.snapshot, key: step.key }
        observationMayBeStale = true
        await act(action)
        dispatched++
        await refresh()
        if (step.kind === 'replace') {
          const current = targetOf(step)
          if (!current || current.valueTruncated !== false || current.value !== step.text) throw new Error('The replacement result was not fully observed. Inspect it without repeating the replacement.')
          verified++
        }
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
