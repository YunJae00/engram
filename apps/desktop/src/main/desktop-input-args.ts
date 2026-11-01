import type { DesktopAction } from 'core'
import type { DesktopObservationDto } from '../shared/desktop.js'

export function desktopInputArgs(action: DesktopAction, observation: DesktopObservationDto, scope: Record<string, unknown>): Record<string, unknown> {
  const args: Record<string, unknown> = { ...scope, snapshot: action.snapshot }
  if (action.kind === 'click') {
    if ('element' in action) args['element'] = action.element
    else {
      const bounds = observation.captureBounds
      if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) throw new Error('Observe an app with verified client coordinates before clicking by position.')
      args['x'] = Math.round(bounds.x + action.x * (bounds.width - 1))
      args['y'] = Math.round(bounds.y + action.y * (bounds.height - 1))
    }
  } else if (action.kind === 'replace') Object.assign(args, { element: action.element, expected: action.expected, text: action.text })
  else if (action.kind === 'type') args['text'] = action.text
  else if (action.kind === 'scroll') args['delta'] = action.delta
  else args['key'] = action.key
  return args
}
