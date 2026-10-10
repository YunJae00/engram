import { successfulTurnSteps, type AgentLoopResult, type TurnStep } from 'core'

export const RESULT_CHANGES = /^(page_steps|press|press_key|press_point|type_text|choose|upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package)$/
const VIEW_MOVES = /^(open_page|search_web|read_pages|scroll|hover|reveal)$/
const READBACK = /^(read_open_page|read_pages|look|verify|read_desktop|look_desktop|read_live_document|file_read|file_read_package|file_read_workbook|excel_read|word_read|ppt_read)$/

export function freshResultReadback(steps: TurnStep[]): boolean {
  // Failed moves can also invalidate the state observed before them.
  const lastChange = steps.map(step => !step.seeded && (RESULT_CHANGES.test(step.tool) || VIEW_MOVES.test(step.tool))).lastIndexOf(true)
  return successfulTurnSteps(steps.slice(Math.max(0, lastChange))).some(step => READBACK.test(step.tool) || step.observedAfterAction === true)
}

export function canLearnTurn(result: Pick<AgentLoopResult, 'asked' | 'stopped' | 'pending' | 'incomplete' | 'steps'>, held: boolean, check?: { accepted: boolean }): boolean {
  // Held tasks are learned only after the runner confirms their final state.
  if (held || result.asked || result.stopped || result.pending || result.incomplete) return false
  return !check || check.accepted && freshResultReadback(result.steps)
}
