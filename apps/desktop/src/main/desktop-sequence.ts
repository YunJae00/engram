import type { DesktopAction } from 'core'
import type { DesktopObservationDto, DesktopNodeDto } from '../shared/desktop.js'
import { actOnDesktop, desktopObservation, readControlledDesktop } from './desktop-control.js'

const INTERACTIVE = /(?:^|\.)(Button|Edit|ComboBox|ListItem|CheckBox|RadioButton|TabItem|MenuItem|Hyperlink|Slider|Spinner)$/
const identity = (node: DesktopNodeDto) => JSON.stringify([node.name, node.controlType, node.bounds])
const EDIT_KEYS = new Set(['Backspace', 'Delete', 'Space', 'Home', 'End', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Control+A', 'Control+B', 'Control+I', 'Control+U', 'Control+Home', 'Control+End', 'Control+ArrowLeft', 'Control+ArrowRight', 'Shift+Home', 'Shift+End', 'Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Shift+ArrowDown', 'Control+Shift+Home', 'Control+Shift+End', 'Control+Shift+ArrowLeft', 'Control+Shift+ArrowRight'])
const geometry = (view: DesktopObservationDto) => JSON.stringify([view.bounds, view.captureBounds])
function layout(view: DesktopObservationDto): string {
  if (view.truncated !== false) throw new Error('A complete observation is required for a sequence.')
  return JSON.stringify([view.bounds, view.nodes.filter((node) => INTERACTIVE.test(node.controlType)).map(identity).sort()])
}

export async function desktopSequence(lane: string, actions: DesktopAction[], signal?: AbortSignal): Promise<string> {
  const start = performance.now()
  const original = desktopObservation(lane, actions[0]!.snapshot)
  const first = actions[0]!
  const editor = first.kind === 'click' && 'element' in first ? original.nodes.find((node) => node.id === first.element) : undefined
  const editing = editor?.controlType === 'Edit' && editor.actions?.type === true && !!editor.runtimeId
    && actions.slice(1).every((action) => action.kind === 'type' || (action.kind === 'key' && EDIT_KEYS.has(action.key)))
  const expected = editing ? geometry(original) : layout(original)
  const verifyEditor = (view: DesktopObservationDto, requireFocus: boolean) => {
    if (geometry(view) !== expected || (view.truncated !== false && view.captureSafe !== true)) throw new Error('The editing surface could not be verified. Inspect the new state before continuing.')
    const matches = view.nodes.filter((node) => node.runtimeId === editor!.runtimeId && identity(node) === identity(editor!) && node.actions?.type === true)
    if (matches.length !== 1 || (requireFocus && (view.focusedEditable !== true || view.focusedControl !== editor!.runtimeId))) throw new Error('The editor or keyboard focus changed. Inspect the new state before continuing.')
  }
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
      if (editing) verifyEditor(observation, index > 0)
      else if (layout(observation) !== expected) throw new Error('The interface changed. Inspect the new state before continuing.')
      let action = { ...actions[index]!, snapshot: observation.snapshot }
      if (targets[index]) {
        const matches = observation.nodes.filter((node) => identity(node) === targets[index])
        if (matches.length !== 1) throw new Error('The next control is missing or ambiguous.')
        action = { kind: 'click', snapshot: observation.snapshot, element: matches[0]!.id }
      }
      await actOnDesktop(lane, action, signal)
      dispatched++
      observation = await readControlledDesktop(lane, signal, true)
      if (editing) verifyEditor(observation, true)
      completed++
    }
    return JSON.stringify({ completed, elapsedMs: Math.round(performance.now() - start), observation, requiresVerification: true })
  } catch (error) {
    signal?.throwIfAborted()
    return JSON.stringify({ completed, dispatched, failedStep, error: error instanceof Error ? error.message : String(error), elapsedMs: Math.round(performance.now() - start), observation, observationMayBeStale: true })
  }
}
