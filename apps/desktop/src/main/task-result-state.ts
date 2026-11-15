import { commandChanged, handedInFrom } from './result-check.js'
export { commandOnlyReads } from './result-check.js'
import { successfulTurnSteps, type AgentLoopResult, type TurnStep } from 'core'

// Whether a turn's answer is kept out of the thread for the task runner to post: a re-check always, and an answer the runner is about to
// re-check itself (holdIf: a team's merged report, or a result whose check left something open). The re-check is told the person has not seen
// that result, and answers in full: posted before it, the wrap-up appeared twice (qa143 S19 d, S31, S32). The runner posts one of them, once.
// A question, a pending step, a stopped or an unfinished answer is never held here.
export function holdTaskResult(result: Pick<AgentLoopResult, 'answer' | 'steps' | 'asked' | 'pending' | 'stopped' | 'incomplete'>, turn?: { verification?: unknown; holdIf?: (answer: string, steps: TurnStep[], check?: { accepted: boolean; verified?: boolean; issues?: string[] }) => boolean }, check?: { accepted: boolean; verified?: boolean; issues?: string[] }): boolean {
  if (result.asked || result.pending) return false
  if (turn?.verification) return true
  return !result.stopped && !result.incomplete && turn?.holdIf?.(result.answer, result.steps, check) === true
}

export const RESULT_CHANGES = /^(app_do|app_set|app_press|page_steps|press|press_key|press_point|type_text|choose|upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package)$/
// Whether a turn successfully changed a result: any RESULT_CHANGES step (a host hand-in is a file_create_copy, so a task file a command changed counts once it is handed in), a rendered file, or a native file write.
export const changedResult = (steps: TurnStep[]): boolean => successfulTurnSteps(steps).some(step => RESULT_CHANGES.test(step.tool) || /^(render_file|Write|Edit|MultiEdit|NotebookEdit)$/.test(step.tool))
// Work that leaves something behind: a document, a file, an app or a saved
// procedure changed, or a press the person approved because it commits.
// Reading a site - opening tabs, filters, pages - leaves nothing to check.
const LEAVES_WORK = /^(upload_file|run_procedure|desktop_action|desktop_sequence|compose_live_document|edit_live_document|excel_write|word_write|word_edit|ppt_build|ppt_edit|outlook_draft|file_create_copy|file_create_workbook|file_edit_package)$/
// Presses and app actions count only when the host marked them as committing (send, submit, save, delete).
const PRESSES = /^(page_steps|press|press_point|app_do|app_set|app_press)$/
const savedWorkFile = (text = '') => /\]\(engram-artifact:[^\s)]+\.(?:txt|md|json|csv|tsv|xlsx|docx|pptx)\)/i.test(text)

// Whether an answer needs its result checked against the request before the person sees it.
export function needsResultCheck(answer: string, steps: TurnStep[]): boolean {
  return savedWorkFile(answer) || steps.some(step => !step.seeded && step.tool === 'page_steps' && step.committed === true) || successfulTurnSteps(steps).some(step => LEAVES_WORK.test(step.tool) || (PRESSES.test(step.tool) && step.committed === true))
}
const VIEW_MOVES = /^(open_page|search_web|read_pages|scroll|hover|reveal)$/
const READBACK = /^(app_read|app_text|read_open_page|read_pages|look|verify|read_desktop|look_desktop|read_live_document|file_read|file_read_package|file_read_workbook|excel_read|word_read|ppt_read)$/

export function freshResultReadback(steps: TurnStep[]): boolean {
  // Failed moves can also invalidate the state observed before them.
  // A command that may have written a file stales what was read before it, like any other write (qa143 B14).
  // The host's own hand-in copies bytes the result check already tied to a full read; it does not stale the readback.
  const lastChange = steps.map(step => !step.seeded && !handedInFrom(step) && (RESULT_CHANGES.test(step.tool) || VIEW_MOVES.test(step.tool) || commandChanged(step))).lastIndexOf(true)
  return successfulTurnSteps(steps.slice(Math.max(0, lastChange))).some(step => READBACK.test(step.tool) || step.observedAfterAction === true)
}

// Whether a result leaves nothing to read back: no step of the task changed or opened anything and the answer hands over no file.
// A report made only of words (a team's merged text, compared against what the leads wrote) is checked by its result check alone.
export const nothingToReadBack = (answer: string, steps: TurnStep[]): boolean =>
  !/\]\(engram-artifact:/.test(answer) && !steps.some(step => !step.seeded && (RESULT_CHANGES.test(step.tool) || VIEW_MOVES.test(step.tool) || /^(render_file|Write|Edit|MultiEdit|NotebookEdit)$/.test(step.tool) || commandChanged(step)))

export function canLearnTurn(result: Pick<AgentLoopResult, 'asked' | 'stopped' | 'pending' | 'incomplete' | 'steps'>, held: boolean, check?: { accepted: boolean; verified?: boolean; issues?: string[] }): boolean {
  // Held tasks are learned only after the runner confirms their final state.
  if (held || result.asked || result.stopped || result.pending || result.incomplete) return false
  return !check || check.accepted && check.verified !== false && !check.issues?.length && freshResultReadback(result.steps)
}
