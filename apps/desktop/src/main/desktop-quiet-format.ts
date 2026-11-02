import type { QuietControlDto, QuietObservationDto, QuietPressResultDto, QuietReadResultDto, QuietSetResultDto, QuietStateDto } from '../shared/desktop.js'

const TEXT_TAIL = 40
const quote = (value: string): string => JSON.stringify(value)

function personLine(state: QuietStateDto): string {
  if (state.minimized) return 'window minimized'
  if (!state.foreground) return 'person elsewhere'
  return state.idleMs < 4000 ? 'person is using this app now (changes wait)' : `person has it in front, idle ${Math.round(state.idleMs / 1000)}s`
}

export function controlLine(control: QuietControlDto): string {
  const can = [control.can.scroll ? 'scroll' : '', control.can.scrollIntoView ? 'scroll_into_view' : '', control.can.set ? 'set' : '', control.can.press ? 'press' : '', control.can.text && control.type !== 'Text' ? 'text' : ''].filter(Boolean)
  const flags = [control.state?.checked ? `checked:${control.state.checked}` : '', control.state?.selected === undefined ? '' : `selected:${control.state.selected}`, control.state?.expanded ? `expanded:${control.state.expanded}` : '', !control.enabled ? 'disabled' : '', control.offscreen ? 'offscreen' : '', control.focused ? 'focused' : '', control.secret ? 'secret' : ''].filter(Boolean)
  const value = control.can.set ? control.value ? ` = ${quote(control.value)}` : control.placeholder ? ' (empty, shows placeholder)' : ' (empty)' : ''
  return `${control.id}${control.parent ? ` parent:${control.parent}` : ''}${control.order === undefined ? '' : ` order:${control.order}`}${control.depth === undefined ? '' : ` depth:${control.depth}`} ${control.type} ${quote(control.name)}${can.length ? ` [${can.join(',')}]` : ''}${value}${flags.length ? ` {${flags.join(',')}}` : ''}${control.subtreeTruncated ? ` [truncated; children:${control.childCount ?? 'unknown'}]` : ''}`
}

export function formatScan(observation: QuietObservationDto, find: string | undefined): string {
  const shown = find ? observation.texts : observation.texts.slice(-TEXT_TAIL)
  const hidden = observation.texts.length - shown.length + observation.skippedTexts
  const lines = [
    ...(observation.mode || observation.truncated || observation.sparseTree || hidden > 0 ? [JSON.stringify({ mode: observation.mode ?? 'full', root: observation.root, ...(observation.sparseTree ? { sparseTree: true, hint: observation.hint } : {}), truncated: !!observation.truncated || hidden > 0, ...(observation.truncated || hidden > 0 ? { continuation: 'Use app_read mode:skeleton, then root:<region id> with that snapshot. Read only the required region; this is not the whole app.' } : {}) })] : []),
    `${observation.title} [window:${observation.window}:0] — snapshot ${observation.snapshot} (${personLine(observation.state)}${find ? `, find ${quote(find)}` : ''})`,
    `controls (${observation.controls.length}${observation.skippedControls ? `; ${observation.skippedControls} more not shown, narrow with root and snapshot` : ''}):`,
    ...observation.controls.map(controlLine),
    `text (${shown.length}${hidden ? ` of ${observation.texts.length + observation.skippedTexts}; partial text; narrow with root and snapshot` : ''}):`,
    ...shown.map(text => `${text.id}${text.parent ? ` parent:${text.parent}` : ''}${text.order === undefined ? '' : ` order:${text.order}`}: ${text.text.replace(/\s+/g, ' ').trim()}`),
  ]
  return lines.join('\n')
}

export function formatSet(result: QuietSetResultDto, text: string): string {
  return JSON.stringify({ ...result, expected: text, requiresVerification: true })
}

export function formatPress(result: QuietPressResultDto): string {
  return JSON.stringify({ ...result, requiresVerification: true })
}

export function formatText(result: QuietReadResultDto & { settled: boolean; waitedMs: number }): string {
  return JSON.stringify(result)
}
