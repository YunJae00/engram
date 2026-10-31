import type { QuietControlDto, QuietObservationDto, QuietPressResultDto, QuietReadResultDto, QuietSetResultDto, QuietStateDto } from '../shared/desktop.js'

// What the brain reads back from the quiet tools: one line per control, the
// flags only when they say something, the text tail last. A list this short
// is what keeps a step quick; the full JSON would cost more to read than the
// app took to answer.
const TEXT_TAIL = 40
const quote = (value: string): string => JSON.stringify(value)

function personLine(state: QuietStateDto): string {
  if (state.minimized) return 'window minimized'
  if (!state.foreground) return 'person elsewhere'
  return state.idleMs < 4000 ? 'person is using this app now (changes wait)' : `person has it in front, idle ${Math.round(state.idleMs / 1000)}s`
}

export function controlLine(control: QuietControlDto): string {
  const can = [control.can.set ? 'set' : '', control.can.press ? 'press' : '', control.can.text && control.type !== 'Text' ? 'text' : ''].filter(Boolean)
  const flags = [!control.enabled ? 'disabled' : '', control.offscreen ? 'offscreen' : '', control.focused ? 'focused' : '', control.secret ? 'secret' : ''].filter(Boolean)
  const value = control.can.set ? control.value ? ` = ${quote(control.value)}` : control.placeholder ? ' (empty, shows placeholder)' : ' (empty)' : ''
  return `${control.id} ${control.type} ${quote(control.name)}${can.length ? ` [${can.join(',')}]` : ''}${value}${flags.length ? ` {${flags.join(',')}}` : ''}`
}

export function formatScan(observation: QuietObservationDto, find: string | undefined): string {
  const shown = find ? observation.texts : observation.texts.slice(-TEXT_TAIL)
  const hidden = observation.texts.length - shown.length + observation.skippedTexts
  const lines = [
    `${observation.title} [window:${observation.window}:0] — snapshot ${observation.snapshot} (${personLine(observation.state)}${find ? `, find ${quote(find)}` : ''})`,
    `controls (${observation.controls.length}${observation.skippedControls ? `; ${observation.skippedControls} more not shown, narrow with find` : ''}):`,
    ...observation.controls.map(controlLine),
    `text (${shown.length}${hidden ? ` of ${observation.texts.length + observation.skippedTexts}; app_text reads it all` : ''}):`,
    ...shown.map(text => `${text.id}: ${text.text.replace(/\s+/g, ' ').trim()}`),
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
