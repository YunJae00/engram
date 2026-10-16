import { successfulTurnSteps, type AgentLoopResult, type TurnStep } from 'core'

export function holdTaskResult(result: Pick<AgentLoopResult, 'answer' | 'steps' | 'asked' | 'pending' | 'stopped' | 'incomplete'>, turn?: { verification?: unknown; holdIf?: (answer: string, steps: TurnStep[]) => boolean }): boolean {
  return !result.asked && !result.pending && !!turn && (!!turn.verification || !!result.incomplete || !!result.stopped || !!turn.holdIf?.(result.answer, result.steps))
}

export const RESULT_CHANGES = /^(app_do|app_set|app_press|page_steps|press|press_key|press_point|type_text|choose|upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package)$/
// Work that leaves something behind: a document, a file, an app or a saved
// procedure changed, or a press the person approved because it commits.
// Reading a site - opening tabs, filters, pages - leaves nothing to check.
const LEAVES_WORK = /^(app_do|app_set|app_press|upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package)$/
const PRESSES = /^(page_steps|press|press_point)$/
const savedWorkFile = (text = '') => /\]\(engram-artifact:[^\s)]+\.(?:txt|md|json|csv|tsv|xlsx|docx|pptx)\)/i.test(text)

// Whether an answer needs its result checked against the request before the person sees it.
export function needsResultCheck(answer: string, steps: TurnStep[]): boolean {
  return savedWorkFile(answer) || steps.some(step => !step.seeded && step.tool === 'page_steps' && step.committed === true) || successfulTurnSteps(steps).some(step => LEAVES_WORK.test(step.tool) || (PRESSES.test(step.tool) && step.committed === true))
}
const VIEW_MOVES = /^(open_page|search_web|read_pages|scroll|hover|reveal)$/
const READBACK = /^(app_read|app_text|read_open_page|read_pages|look|verify|read_desktop|look_desktop|read_live_document|file_read|file_read_package|file_read_workbook|excel_read|word_read|ppt_read)$/

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
