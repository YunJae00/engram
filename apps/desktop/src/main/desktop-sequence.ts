import type { DesktopAction } from 'core'
import type { DesktopObservationDto, DesktopNodeDto } from '../shared/desktop.js'
import { actOnDesktop, desktopObservation, readControlledDesktop } from './desktop-control.js'

const INTERACTIVE = /(?:^|\.)(Button|Edit|ComboBox|ListItem|CheckBox|RadioButton|TabItem|MenuItem|Hyperlink|Slider|Spinner)$/
const identity = (node: DesktopNodeDto) => JSON.stringify([node.name, node.controlType, node.bounds])
function layout(view: DesktopObservationDto): string {
  if (view.truncated !== false) throw new Error('A complete observation is required for a sequence.')
  return JSON.stringify([view.bounds, view.nodes.filter((node) => INTERACTIVE.test(node.controlType)).map(identity).sort()])
}

export async function desktopSequence(lane: string, actions: DesktopAction[], signal?: AbortSignal): Promise<string> {
  const start = performance.now()
  const original = desktopObservation(lane, actions[0]!.snapshot)
  const expected = layout(original)
  const targets = actions.map((action) => {
    if (action.kind !== 'click' || !('element' in action)) return undefined
    const node = original.nodes.find((one) => one.id === action.element)
    if (!node?.name || !INTERACTIVE.test(node.controlType)) throw new Error('Sequence clicks need named interactive controls from the current observation.')
    return identity(node)
  })
  let completed = 0
  let dispatched = 0
  let failedStep = 1
  let observation = original
  try {
    observation = await readControlledDesktop(lane, signal, true)
    for (let index = 0; index < actions.length; index++) {
      failedStep = index + 1
      signal?.throwIfAborted()
      if (performance.now() - start > 20000) throw new Error('Sequence time limit reached. Inspect the current state before continuing.')
      if (layout(observation) !== expected) throw new Error('The interface changed. Inspect the new state before continuing.')
      let action = { ...actions[index]!, snapshot: observation.snapshot }
      if (targets[index]) {
        const matches = observation.nodes.filter((node) => identity(node) === targets[index])
        if (matches.length !== 1) throw new Error('The next control is missing or ambiguous.')
        action = { kind: 'click', snapshot: observation.snapshot, element: matches[0]!.id }
      }
      await actOnDesktop(lane, action, signal)
      dispatched++
      observation = await readControlledDesktop(lane, signal, true)
      completed++
    }
    return JSON.stringify({ completed, elapsedMs: Math.round(performance.now() - start), observation })
  } catch (error) {
    signal?.throwIfAborted()
    return JSON.stringify({ completed, dispatched, failedStep, error: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - start), observation, observationMayBeStale: true })
  }
}
