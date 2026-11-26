import { commandChanged, handedInFrom, wroteFile } from './result-check.js'
export { commandOnlyReads } from './result-check.js'
import { successfulTurnSteps, type AgentLoopResult, type TurnStep } from 'core'

export const RESULT_CHANGES = /^(app_do|app_set|app_press|page_steps|press|press_key|press_point|type_text|choose|upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package|file_move)$/
export const changedResult = (steps: TurnStep[]): boolean => successfulTurnSteps(steps).some(step => RESULT_CHANGES.test(step.tool) || /^(render_file|Write|Edit|MultiEdit|NotebookEdit)$/.test(step.tool)) || steps.some(step => !step.seeded && commandChanged(step))
const LEAVES_WORK = /^(upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package|file_move)$/
const PRESSES = /^(page_steps|press|press_point|app_do|app_set|app_press)$/
const savedWorkFile = (text = '') => /\]\(engram-artifact:[^\s)]+\.(?:txt|md|json|csv|tsv|xlsx|docx|pptx)\)/i.test(text)

export function needsResultCheck(answer: string, steps: TurnStep[]): boolean {
  return savedWorkFile(answer) || steps.some(step => !step.seeded && step.tool === 'page_steps' && step.committed === true) || successfulTurnSteps(steps).some(step => LEAVES_WORK.test(step.tool) || (PRESSES.test(step.tool) && step.committed === true))
}
const VIEW_MOVES = /^(open_page|search_web|read_pages|scroll|hover|reveal)$/
const READBACK = /^(app_read|app_text|read_open_page|read_pages|look|verify|read_desktop|look_desktop|read_live_document|file_read|file_read_package|file_read_workbook|excel_read|word_read|ppt_read)$/

export function freshResultReadback(steps: TurnStep[]): boolean {
  const lastChange = steps.map(step => !step.seeded && !handedInFrom(step) && (RESULT_CHANGES.test(step.tool) || VIEW_MOVES.test(step.tool) || wroteFile(step))).lastIndexOf(true)
  return successfulTurnSteps(steps.slice(Math.max(0, lastChange))).some(step => READBACK.test(step.tool) || step.observedAfterAction === true)
}

export const nothingToReadBack = (answer: string, steps: TurnStep[]): boolean =>
  !/\]\(engram-artifact:/.test(answer) && !steps.some(step => !step.seeded && (RESULT_CHANGES.test(step.tool) || VIEW_MOVES.test(step.tool) || step.tool === 'render_file' || wroteFile(step)))

export function canLearnTurn(result: Pick<AgentLoopResult, 'asked' | 'stopped' | 'pending' | 'incomplete' | 'steps'>, held: boolean, check?: { accepted: boolean; verified?: boolean; issues?: string[] }): boolean {
  if (held || result.asked || result.stopped || result.pending || result.incomplete) return false
  return !check || check.accepted && check.verified !== false && !check.issues?.length && freshResultReadback(result.steps)
}
