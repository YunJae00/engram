import type { DesktopNodeDto, DesktopObservationDto } from '../shared/desktop.js'

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
