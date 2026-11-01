import type { DesktopObservationDto, QuietObservationDto } from '../shared/desktop.js'

const CHROME = /^(close|minimi[sz]e|maximi[sz]e|restore|full[ -]?screen|zoom|닫기|최소화|최대화|복원|전체\s?화면)$/i
export const SCREEN_HINT = 'This app exposes little accessibility info; read it with look_desktop (screenshot) and act by coordinates after checking the visible target.'
export function sparseDesktopTree(observation: QuietObservationDto, threshold = 5): boolean {
  if (observation.truncated || observation.skippedControls > 0 || observation.root || observation.mode === 'skeleton') return false
  const bounds = observation.bounds
  if (!bounds || bounds.width < 240 || bounds.height < 160) return false
  return observation.controls.filter(control => !control.secret && control.enabled && !control.offscreen && !CHROME.test(control.name.trim()) && (control.can.set || control.can.press)).length <= threshold
}

export function markSparseObservation(observation: DesktopObservationDto, options: { mode?: string; root?: string }): void {
  if (observation.scope === 'focus' || options.root || options.mode === 'skeleton') return
  const controls = observation.nodes.map(node => ({
    id: node.id, name: node.name, type: node.controlType, secret: !!(node.password || node.isPassword), enabled: node.enabled !== false,
    offscreen: node.offscreen === true, focused: false,
    can: { set: !!node.actions?.type, press: !!node.actions?.click && /button|link|item|checkbox|radio|slider|switch/i.test(node.controlType), text: false },
  }))
  observation.sparseTree = sparseDesktopTree({
    ...observation, controls, window: '', pid: 0, title: '', texts: [], skippedControls: 0, skippedTexts: 0, ms: 0,
    state: { foreground: false, minimized: false, idleMs: 0 },
  })
  if (observation.sparseTree) observation.hint = SCREEN_HINT
}
