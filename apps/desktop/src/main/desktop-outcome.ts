import type { DesktopObservationDto } from '../shared/desktop.js'
import { STILL_CHANGING } from './desktop-guarded-sequence.js'
import { TARGET_MOVING } from './desktop-settle.js'

export interface DesktopOutcome { done: boolean; stillMoving: boolean; reason?: string; summary: string }
type Result = Record<string, unknown>
type Words = [ko: string, en: string]

const PERMISSIONS: Record<string, Words> = {
  accessibility_denied: ['손쉬운 사용', 'Accessibility'],
  screen_recording_denied: ['화면 기록', 'Screen Recording'],
  input_monitoring_denied: ['입력 모니터링', 'Input Monitoring'],
}
const MOVING: Words = ['화면이 아직 바뀌는 중이라 확인하지 못했어', 'the window was still changing, so it is not confirmed']
const UNREAD: Words = ['입력창 내용을 다시 읽지 못했어', 'the field could not be read back']
const NOT_FOUND: Words = ['입력창을 찾지 못했어', 'the text field was not found']
const line = (value: unknown, cap: number) => String(value).replace(/\s+/g, ' ').trim().slice(0, cap)
const holds = (value: string): Words => [`입력창에 "${line(value, 60)}"가 들어가 있어`, `the field holds "${line(value, 60)}"`]

// A step that failed on its own, judged before any text check; undefined when the step itself went through.
function stepFailure(step: Result): { reason: Words; stillMoving?: true } | undefined {
  const error = typeof step['error'] === 'string' ? step['error'] : undefined
  const permission = error && PERMISSIONS[error]
  if (permission) return { reason: [`${permission[0]} 권한이 꺼져 있어`, `${permission[1]} permission is off`] }
  if (step['stillChanging'] !== undefined || [STILL_CHANGING, TARGET_MOVING].includes(String(error ?? step['reason'] ?? ''))) return { reason: MOVING, stillMoving: true }
  if (step['noEffect'] !== undefined) return { reason: ['눌렀는데 화면이 바뀌지 않았어', 'the click had no visible effect'] }
  if (error === 'policy_denied') return { reason: ['허락이 없어서 하지 않았어', 'not approved, nothing was sent'] }
  if (error === 'element_not_found') return { reason: NOT_FOUND }
  if (error) return { reason: [line(step['reason'] ?? error, 120), line(step['reason'] ?? error, 120)] }
  if (step['observationMayBeStale']) return { reason: UNREAD }
  return undefined
}

// The focused control counts only when it is a message field: a search or find box holding the text is not the composer.
const FIELD = /Text(Area|Field)|ComboBox|TextEdit|Edit\b/i
const SEARCH = /search|find|filter|검색|찾기/i
function focusedField(view: unknown): { value?: string; composer: boolean } {
  const observation = view as DesktopObservationDto | undefined
  const field = observation?.nodes?.find(node => node.runtimeId && node.runtimeId === observation.focusedControl)
  if (!field) return { composer: false }
  const composer = FIELD.test(field.controlType) && !/SearchField/i.test(field.controlType) && !SEARCH.test(field.name ?? '')
  return { composer, ...(typeof field.value === 'string' && !field.valueTruncated ? { value: field.value } : {}) }
}

// The whole field must read exactly the requested text: a draft that was already there makes it differ.
export function textCheck(tool: string, result: Result, text: string): Words | undefined {
  const wanted = text.normalize('NFC')
  // app_set: the settled read-back (valueNow) wins over the receipt; null means the field was not found again.
  const settled = result['valueNow']
  const focused = tool === 'app_set' ? undefined : focusedField(result['observation'])
  const value = tool === 'app_set' ? (typeof settled === 'string' ? settled : settled === null ? undefined : typeof result['value'] === 'string' ? result['value'] : undefined) : focused!.value
  const typed = result['typed'] as { verified?: boolean; landed?: string } | undefined
  if (tool !== 'app_set' && (!typed || (result['observation'] !== undefined && !focused!.composer))) return NOT_FOUND
  if (tool === 'app_set' && settled === null && 'appNow' in result) return UNREAD
  if (tool === 'app_set' && result['landed'] === false) return UNREAD
  if (value !== undefined && value.normalize('NFC') !== wanted) return holds(value)
  if (typed?.landed !== undefined) return holds(typed.landed)
  if (value === undefined || typed?.verified === false || (tool === 'app_set' && result['exact'] === false)) return UNREAD
  return undefined
}

export interface OutcomeState { korean: boolean; app?: string; openFailed?: Words; opened?: boolean; text?: string; textFailure?: Words }

// The verdict of the turn so far after the latest step; undefined until the turn opened an app or inserted text.
export function desktopOutcome(state: OutcomeState, last: Result, inserted: boolean): DesktopOutcome | undefined {
  const pick = ([ko, en]: Words) => state.korean ? ko : en
  if (state.opened === undefined && state.text === undefined) return undefined
  const failed = state.openFailed ? { reason: state.openFailed } : stepFailure(last) ?? (state.textFailure ? { reason: state.textFailure } : undefined)
  if (failed) {
    const reason = pick(failed.reason)
    return { done: false, stillMoving: !!failed.stillMoving, reason, summary: state.korean ? `못 했어. ${reason}.` : `Not done: ${reason}.` }
  }
  if (state.text === undefined) return undefined
  const app = state.app && state.opened ? line(state.app, 40) : undefined
  const summary = !inserted ? pick(['했어.', 'Done.'])
    : state.korean ? `${app ? `${app} 열고 ` : ''}입력창에 ${line(state.text, 60)} 써 뒀어. 보내진 않았어.`
    : `${app ? `Opened ${app} and put` : 'Put'} "${line(state.text, 60)}" in the message box. Not sent.`
  return { done: true, stillMoving: false, summary }
}

function insertedText(tool: string, args: Result): string | undefined {
  if (tool === 'app_set' || (tool === 'desktop_action' && args['kind'] === 'type')) return typeof args['text'] === 'string' ? args['text'] : undefined
  if (tool !== 'desktop_sequence' || !Array.isArray(args['actions'])) return undefined
  const typed = (args['actions'] as Result[]).filter(action => action['kind'] === 'type').at(-1)?.['text']
  return typeof typed === 'string' ? typed : undefined
}

// One chain per tool set (one turn): a typed text that failed its read-back stays failed until a new insert verifies,
// so a later click or press can never turn the verdict into done.
export function outcomeChain(): { add(tool: string, args: Result, raw: string, task: string | undefined, boundApp: string | undefined): string } {
  let task: string | undefined
  let state: OutcomeState = { korean: false }
  return {
    add(tool, args, raw, nextTask, boundApp) {
      let result: Result
      try { result = JSON.parse(raw) as Result } catch { return raw }
      if (!result || typeof result !== 'object' || Array.isArray(result)) return raw
      if (nextTask !== task || tool === 'open_app') { task = nextTask; state = { korean: /[가-힣]/.test(nextTask ?? '') } }
      if (tool === 'open_app') {
        state.app = typeof result['title'] === 'string' ? result['title'] : String(args['app'] ?? '')
        state.opened = !result['error'] && (result['opened'] !== false || result['alreadyOpen'] === true)
        if (state.opened) return raw
        const why = line(result['reason'] ?? result['error'] ?? '', 80)
        state.openFailed = [`${line(args['app'] ?? state.app, 40)} 앱을 열지 못했어${why ? ` (${why})` : ''}`, `could not open ${line(args['app'] ?? state.app, 40)}${why ? ` (${why})` : ''}`]
      }
      state.app ??= boundApp
      const text = insertedText(tool, args)
      if (text !== undefined) { state.text = text; state.textFailure = textCheck(tool, result, text) }
      const outcome = desktopOutcome(state, result, text !== undefined)
      return outcome ? JSON.stringify({ outcome, ...result }) : raw
    },
  }
}
